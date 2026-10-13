mod matcher;
mod scrub;
mod vault;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager};
use vault::Vault;

/// The KYC profile. Held behind a lock; only the commands below touch it.
struct VaultState(Mutex<Vault>);

/// PDF paths passed on the command line at launch (e.g. double-clicking a .pdf in Explorer).
struct LaunchFiles(Mutex<Vec<String>>);

fn pdf_args(args: &[String]) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|a| a.to_lowercase().ends_with(".pdf"))
        .cloned()
        .collect()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
fn launch_files(state: tauri::State<LaunchFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

/// File types the page may read and write. Anything else (programs, scripts, shortcuts, system
/// files) is refused, so a compromised page can't drop or read arbitrary files.
const READ_EXT: &[&str] = &["pdf", "png", "jpg", "jpeg", "docx", "xlsx", "docm", "xlsm", "json"];
const WRITE_EXT: &[&str] = &["pdf", "png", "json", "docx", "xlsx", "docm", "xlsm"];

fn checked_path(path: &str, allowed: &[&str]) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let bad = |why: &str| Err(format!("Proof won't use {path}: {why}."));
    if path.starts_with("\\\\?\\") || path.starts_with("\\\\.\\") || path.starts_with("//?/") || path.starts_with("//./") {
        return bad("device paths aren't allowed");
    }
    if !p.is_absolute() {
        return bad("not a full path");
    }
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    // A colon after the drive letter means an alternate data stream (file.pdf:hidden).
    if name.contains(':') || name.ends_with('.') || name.ends_with(' ') || name.is_empty() {
        return bad("not an ordinary file name");
    }
    let ext = p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
    if !allowed.contains(&ext.as_str()) {
        return bad("not a file type Proof works with");
    }
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return bad("the path climbs out of its folder");
    }
    Ok(p)
}

#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    let p = checked_path(&path, READ_EXT)?;
    let meta = std::fs::metadata(&p).map_err(|e| format!("Couldn't read {path}: {e}"))?;
    if meta.len() > 300 * 1024 * 1024 {
        return Err(format!("{path} is larger than 300 MB."));
    }
    std::fs::read(&p)
        .map(Response::new)
        .map_err(|e| format!("Couldn't read {path}: {e}"))
}

/// Writes the raw request body to the path in the `x-path` header (percent-encoded).
/// Writes to a temporary file first, then replaces the target, so a failed save never
/// leaves a half-written file behind.
#[tauri::command]
fn write_file(request: Request) -> Result<(), String> {
    let raw = request
        .headers()
        .get("x-path")
        .ok_or("Missing file path")?
        .to_str()
        .map_err(|e| e.to_string())?;
    let path = percent_decode(raw);
    checked_path(&path, WRITE_EXT)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected file contents".into());
    };
    let tmp = format!("{path}.proof-tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("Couldn't write {path}: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "Couldn't replace {path}: {e}. Is it open in another program?"
        ));
    }
    Ok(())
}

/// A Unicode TrueType font for text Proof adds to pages. Empty when none is found.
#[tauri::command]
fn system_font(bold: Option<bool>) -> Response {
    let candidates: &[&str] = if bold.unwrap_or(false) {
        &[
            "C:\\Windows\\Fonts\\arialbd.ttf",
            "C:\\Windows\\Fonts\\segoeuib.ttf",
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        ]
    } else {
        &[
            "C:\\Windows\\Fonts\\arial.ttf",
            "C:\\Windows\\Fonts\\segoeui.ttf",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
    };
    for c in candidates {
        if let Ok(b) = std::fs::read(c) {
            return Response::new(b);
        }
    }
    Response::new(Vec::<u8>::new())
}

// ---------------------------------------------------------------- KYC profile vault

fn config_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("kyc.json"))
}
fn default_vault(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir().map(|d| d.join("kyc.vault")).unwrap_or_else(|_| PathBuf::from("kyc.vault"))
}
fn configured_vault(app: &tauri::AppHandle) -> PathBuf {
    config_file(app)
        .ok()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["path"].as_str().map(PathBuf::from))
        .unwrap_or_else(|| default_vault(app))
}
fn remember_vault(app: &tauri::AppHandle, p: &std::path::Path) -> Result<(), String> {
    let f = config_file(app)?;
    if let Some(d) = f.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    std::fs::write(f, serde_json::json!({ "path": p }).to_string()).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct VaultInfo {
    path: String,
    exists: bool,
    unlocked: bool,
    has_key: bool,
}

#[tauri::command]
fn vault_info(state: tauri::State<VaultState>) -> VaultInfo {
    let mut v = state.0.lock().unwrap();
    let unlocked = v.check();
    VaultInfo { path: v.path.display().to_string(), exists: v.exists(), unlocked, has_key: matcher::api_key().is_some() }
}

#[tauri::command]
async fn vault_create(app: tauri::AppHandle, state: tauri::State<'_, VaultState>, passphrase: String, initial: String, path: Option<String>) -> Result<(), String> {
    let target = path.map(PathBuf::from).unwrap_or_else(|| configured_vault(&app));
    if target.extension().map(|e| e != "vault").unwrap_or(true) {
        return Err("A profile file has to end in .vault.".into());
    }
    let mut fresh = Vault::new(target.clone());
    let fresh = tauri::async_runtime::spawn_blocking(move || fresh.create(&passphrase, &initial).map(|_| fresh))
        .await
        .map_err(|e| e.to_string())??;
    remember_vault(&app, &target)?;
    *state.0.lock().unwrap() = fresh;
    Ok(())
}

#[tauri::command]
async fn vault_unlock(state: tauri::State<'_, VaultState>, passphrase: String) -> Result<String, String> {
    let path = state.0.lock().unwrap().path.clone();
    let mut v = Vault::new(path);
    let (v, data) = tauri::async_runtime::spawn_blocking(move || v.unlock(&passphrase).map(|d| (v, d)))
        .await
        .map_err(|e| e.to_string())??;
    *state.0.lock().unwrap() = v;
    Ok(data)
}

/// Point Proof at an existing profile file, e.g. one in a shared folder.
#[tauri::command]
fn vault_use(app: tauri::AppHandle, state: tauri::State<VaultState>, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.extension().map(|e| e != "vault").unwrap_or(true) {
        return Err("That isn't a Proof profile (.vault) file.".into());
    }
    if !p.is_file() {
        return Err(format!("{path} doesn't exist."));
    }
    remember_vault(&app, &p)?;
    *state.0.lock().unwrap() = Vault::new(p);
    Ok(())
}

#[tauri::command]
fn vault_lock(state: tauri::State<VaultState>) {
    state.0.lock().unwrap().lock();
}

#[tauri::command]
fn vault_get(state: tauri::State<VaultState>) -> Result<String, String> {
    state.0.lock().unwrap().get()
}

#[tauri::command]
fn vault_save(state: tauri::State<VaultState>, data: String, force: Option<bool>) -> Result<(), String> {
    state.0.lock().unwrap().save(&data, force.unwrap_or(false))
}

#[tauri::command]
async fn vault_passphrase(state: tauri::State<'_, VaultState>, old: String, new: String) -> Result<(), String> {
    // Argon2 twice; fine to hold the lock, nothing else should touch the vault meanwhile.
    let mut v = state.0.lock().unwrap();
    v.change_pass(&old, &new)
}

#[tauri::command]
fn vault_doc_put(state: tauri::State<VaultState>, request: Request) -> Result<(), String> {
    let id = request.headers().get("x-id").ok_or("Missing id")?.to_str().map_err(|e| e.to_string())?.to_string();
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected file contents".into());
    };
    state.0.lock().unwrap().put_doc(&id, bytes)
}

#[tauri::command]
fn vault_doc_get(state: tauri::State<VaultState>, id: String) -> Result<Response, String> {
    state.0.lock().unwrap().get_doc(&id).map(Response::new)
}

#[tauri::command]
fn vault_doc_delete(state: tauri::State<VaultState>, id: String) -> Result<(), String> {
    state.0.lock().unwrap().delete_doc(&id)
}

#[tauri::command]
fn vault_backup(state: tauri::State<VaultState>, dest: String) -> Result<String, String> {
    state.0.lock().unwrap().backup(std::path::Path::new(&dest))
}

// ---------------------------------------------------------------- matching (the only network code)

#[tauri::command]
fn api_key_set(key: String) -> Result<(), String> {
    matcher::set_api_key(&key)
}

#[tauri::command]
async fn match_fields(state: tauri::State<'_, VaultState>, request: matcher::MatchRequest) -> Result<matcher::MatchResult, String> {
    // The scrubber needs the unlocked profile; copy it out so the lock isn't held across the request.
    let profile = {
        let mut v = state.0.lock().unwrap();
        if !v.check() {
            return Err("LOCKED: Unlock the profile first.".into());
        }
        v.data().unwrap_or_default().to_string()
    };
    matcher::run(request, &profile).await
}

#[tauri::command]
fn match_preview(state: tauri::State<VaultState>, request: matcher::MatchRequest) -> Result<(String, usize), String> {
    let mut v = state.0.lock().unwrap();
    if !v.check() {
        return Err("LOCKED: Unlock the profile first.".into());
    }
    Ok(matcher::preview(&request, v.data().unwrap_or_default()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launch = pdf_args(&std::env::args().collect::<Vec<_>>());
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            let files = pdf_args(&argv);
            if !files.is_empty() {
                let _ = app.emit("open-files", files);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(LaunchFiles(Mutex::new(launch)))
        .setup(|app| {
            let path = configured_vault(app.handle());
            app.manage(VaultState(Mutex::new(Vault::new(path))));
            // Lock after 15 minutes without use even if the window is hung or hidden, and tell the page.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(20));
                let st = handle.state::<VaultState>();
                let locked_now = {
                    let mut v = st.0.lock().unwrap();
                    let was = v.data().is_some();
                    was && !v.check()
                };
                if locked_now {
                    let _ = handle.emit("vault-locked", ());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            launch_files,
            read_file,
            write_file,
            system_font,
            vault_info,
            vault_create,
            vault_unlock,
            vault_use,
            vault_lock,
            vault_get,
            vault_save,
            vault_passphrase,
            vault_doc_put,
            vault_doc_get,
            vault_doc_delete,
            vault_backup,
            api_key_set,
            match_fields,
            match_preview
        ])
        .run(tauri::generate_context!())
        .expect("error while running Proof");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_access_limits() {
        assert!(checked_path("/tmp/form.pdf", WRITE_EXT).is_ok());
        assert!(checked_path("/tmp/Form.XLSX", WRITE_EXT).is_ok());
        for bad in ["/tmp/evil.exe", "/tmp/run.bat", "/tmp/link.lnk", "/tmp/x.pdf.", "/tmp/x.pdf ", "/tmp/x.pdf:hidden", "/tmp/../etc/x.pdf", "x.pdf", "/tmp/noext"] {
            assert!(checked_path(bad, WRITE_EXT).is_err(), "{bad}");
        }
        assert!(checked_path("/tmp/a.jpg", READ_EXT).is_ok());
        assert!(checked_path("/tmp/a.jpg", WRITE_EXT).is_err());
    }
}

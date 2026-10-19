mod grants;
mod matcher;
mod placement;
mod scrub;
mod vault;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request, Response};
use grants::Grants;
use tauri::{Emitter, Manager};
use vault::Vault;

/// Files opened or saved recently, newest first. Every entry was granted when it was added.
struct Recent(Mutex<Vec<String>>);

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
/// files) is refused. On top of this, a path must have been granted (see grants.rs).
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
fn read_file(grants: tauri::State<Grants>, path: String) -> Result<Response, String> {
    let p = checked_path(&path, READ_EXT)?;
    if !grants.may_read(&p) {
        return Err(format!("Proof won't open {path}: it wasn't chosen in Proof. Open it with Open or by dropping it on the window."));
    }
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
fn write_file(grants: tauri::State<Grants>, request: Request) -> Result<(), String> {
    let raw = request
        .headers()
        .get("x-path")
        .ok_or("Missing file path")?
        .to_str()
        .map_err(|e| e.to_string())?;
    let path = percent_decode(raw);
    let p = checked_path(&path, WRITE_EXT)?;
    if !grants.may_write(&p) {
        if !grants.has_file(&p) && p.exists() {
            return Err(format!("{path} already exists. Choose an empty folder, or delete the old files first."));
        }
        return Err(format!("Proof won't save to {path}: that location wasn't chosen in Proof."));
    }
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
    // Proof made this file, so it may write it again (e.g. exporting to the same folder twice).
    grants.file(&p);
    Ok(())
}

// ---------------------------------------------------------------- file dialogs
// The dialogs run here rather than in the page, so the paths they return can be granted.

#[derive(serde::Deserialize)]
struct Filter {
    name: String,
    extensions: Vec<String>,
}

fn file_dialog(app: &tauri::AppHandle, title: Option<String>, filters: &[Filter]) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    use tauri_plugin_dialog::DialogExt;
    let mut d = app.dialog().file();
    if let Some(w) = app.get_webview_window("main") {
        d = d.set_parent(&w);
    }
    if let Some(t) = title {
        d = d.set_title(t);
    }
    for f in filters {
        let ex: Vec<&str> = f.extensions.iter().map(|s| s.as_str()).collect();
        d = d.add_filter(&f.name, &ex);
    }
    d
}

#[tauri::command]
async fn pick_open(app: tauri::AppHandle, title: Option<String>, filters: Vec<Filter>, multiple: bool) -> Vec<String> {
    let d = file_dialog(&app, title, &filters);
    let paths: Vec<PathBuf> = if multiple {
        d.blocking_pick_files().unwrap_or_default().into_iter().filter_map(|f| f.into_path().ok()).collect()
    } else {
        d.blocking_pick_file().and_then(|f| f.into_path().ok()).into_iter().collect()
    };
    let g = app.state::<Grants>();
    paths.iter().for_each(|p| g.file(p));
    paths.into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

#[tauri::command]
async fn pick_save(app: tauri::AppHandle, default_path: Option<String>, name: String, ext: String) -> Option<String> {
    let mut d = file_dialog(&app, None, &[Filter { name, extensions: vec![ext] }]);
    if let Some(def) = default_path {
        let def = PathBuf::from(def);
        if let Some(n) = def.file_name() {
            d = d.set_file_name(n.to_string_lossy());
        }
        if let Some(dir) = def.parent().filter(|p| p.is_absolute()) {
            d = d.set_directory(dir);
        }
    }
    let p = d.blocking_save_file()?.into_path().ok()?;
    app.state::<Grants>().file(&p);
    Some(p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle, title: Option<String>) -> Option<String> {
    let p = file_dialog(&app, title, &[]).blocking_pick_folder()?.into_path().ok()?;
    app.state::<Grants>().dir(&p);
    Some(p.to_string_lossy().into_owned())
}

#[tauri::command]
fn recent_list(recent: tauri::State<Recent>) -> Vec<String> {
    recent.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Only paths the person chose can go on the list, so the list can't be used to grant paths.
#[tauri::command]
fn recent_add(app: tauri::AppHandle, recent: tauri::State<Recent>, grants: tauri::State<Grants>, path: String) {
    if checked_path(&path, READ_EXT).is_err() || !grants.has_file(std::path::Path::new(&path)) {
        return;
    }
    let mut l = recent.0.lock().unwrap_or_else(|e| e.into_inner());
    grants::recent_push(&mut l, &path);
    grants::recent_store(&app, &l);
}

#[tauri::command]
fn recent_forget(app: tauri::AppHandle, recent: tauri::State<Recent>, path: String) {
    let mut l = recent.0.lock().unwrap_or_else(|e| e.into_inner());
    l.retain(|p| p != &path);
    grants::recent_store(&app, &l);
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
    let chosen = path.is_some();
    let target = path.map(PathBuf::from).unwrap_or_else(|| configured_vault(&app));
    if target.extension().map(|e| e != "vault").unwrap_or(true) {
        return Err("A profile file has to end in .vault.".into());
    }
    if chosen && !app.state::<Grants>().may_write(&target) {
        return Err("Choose where to keep the profile with Choose location.".into());
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
    if !app.state::<Grants>().has_file(&p) {
        return Err("Choose the profile file in the Open dialog.".into());
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
fn vault_backup(state: tauri::State<VaultState>, grants: tauri::State<Grants>, dest: String) -> Result<String, String> {
    if !grants.has_dir(std::path::Path::new(&dest)) {
        return Err("Choose the backup folder in the folder dialog.".into());
    }
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
    matcher::preview(&request, v.data().unwrap_or_default())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launch = pdf_args(&std::env::args().collect::<Vec<_>>());
    let grants = Grants::default();
    launch.iter().for_each(|p| grants.file(std::path::Path::new(p)));
    tauri::Builder::default()
        .manage(grants)
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                placement::bring_back(&w);
            }
            let files = pdf_args(&argv);
            let g = app.state::<Grants>();
            files.iter().for_each(|p| g.file(std::path::Path::new(p)));
            if !files.is_empty() {
                let _ = app.emit("open-files", files);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(LaunchFiles(Mutex::new(launch)))
        .manage(placement::WindowMemory::default())
        // Files dropped on the window are granted here, then handed to the page.
        .on_window_event(|window, event| {
            match event {
                // Size and position are remembered for next time and kept on screen.
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    if let Some(w) = window.app_handle().get_webview_window(window.label()) {
                        placement::remember(&w);
                    }
                }
                // Moved to a screen with different scaling, or the scaling or resolution changed: once Windows
                // has resized the window for it, shrink it if it no longer fits.
                tauri::WindowEvent::ScaleFactorChanged { .. } => {
                    let app = window.app_handle().clone();
                    let label = window.label().to_string();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        if let Some(w) = app.get_webview_window(&label) {
                            placement::keep_inside(&w);
                        }
                    });
                }
                tauri::WindowEvent::Destroyed => placement::save(window.app_handle()),
                _ => {}
            }
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let g = window.state::<Grants>();
                let ok: Vec<String> = paths
                    .iter()
                    .filter(|p| checked_path(&p.to_string_lossy(), READ_EXT).is_ok())
                    .map(|p| {
                        g.file(p);
                        p.to_string_lossy().into_owned()
                    })
                    .collect();
                if !ok.is_empty() {
                    let _ = window.emit("dropped-files", ok);
                }
            }
        })
        .setup(|app| {
            let recent = grants::recent_load(app.handle());
            let g = app.state::<Grants>();
            recent.iter().for_each(|p| g.file(std::path::Path::new(p)));
            app.manage(Recent(Mutex::new(recent)));
            let path = configured_vault(app.handle());
            app.manage(VaultState(Mutex::new(Vault::new(path))));
            placement::restore(app.handle());
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
            pick_open,
            pick_save,
            pick_folder,
            recent_list,
            recent_add,
            recent_forget,
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

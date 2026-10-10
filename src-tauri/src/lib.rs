use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager};

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

#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("Couldn't read {path}: {e}"))
}

/// Writes the raw request body to the path in the `x-path` header (percent-encoded).
/// Writes to a temporary file first, then replaces the target, so a failed save never
/// leaves a half-written PDF behind.
#[tauri::command]
fn write_file(request: Request) -> Result<(), String> {
    let raw = request
        .headers()
        .get("x-path")
        .ok_or("Missing file path")?
        .to_str()
        .map_err(|e| e.to_string())?;
    let path = percent_decode(raw);
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
fn system_font() -> Response {
    let candidates = [
        "C:\\Windows\\Fonts\\arial.ttf",
        "C:\\Windows\\Fonts\\segoeui.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ];
    for c in candidates {
        if let Ok(b) = std::fs::read(c) {
            return Response::new(b);
        }
    }
    Response::new(Vec::<u8>::new())
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
        .manage(LaunchFiles(Mutex::new(launch)))
        .invoke_handler(tauri::generate_handler![
            launch_files,
            read_file,
            write_file,
            system_font
        ])
        .run(tauri::generate_context!())
        .expect("error while running Proof");
}

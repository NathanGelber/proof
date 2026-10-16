//! Which files the page may touch. A path becomes usable only when it arrives from the person:
//! a file dialog, a file opened from Explorer, a file dropped on the window, or the recent list
//! (which only ever holds paths that came one of those ways). Paths the page makes up itself are
//! refused before anything touches the disk, so a compromised page can't read or overwrite other
//! files, and can't make Windows connect to a network share it names.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Default)]
pub struct Grants {
    /// Files that may be read and written (opened, saved to, dropped).
    files: Mutex<HashSet<String>>,
    /// Folders chosen in a folder dialog: new files may be written directly inside them.
    dirs: Mutex<HashSet<String>>,
}

/// Compare paths the way Windows does: case-insensitive, either slash.
fn key(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    let s = if cfg!(windows) { s.replace('/', "\\").to_lowercase() } else { s };
    let sep: &[char] = if cfg!(windows) { &['\\', '/'] } else { &['/'] };
    let t = s.trim_end_matches(sep);
    if t.is_empty() { s } else { t.to_string() }
}

impl Grants {
    pub fn file(&self, p: &Path) {
        self.files.lock().unwrap_or_else(|e| e.into_inner()).insert(key(p));
    }
    pub fn dir(&self, p: &Path) {
        self.dirs.lock().unwrap_or_else(|e| e.into_inner()).insert(key(p));
    }
    pub fn has_file(&self, p: &Path) -> bool {
        self.files.lock().unwrap_or_else(|e| e.into_inner()).contains(&key(p))
    }
    pub fn has_dir(&self, p: &Path) -> bool {
        self.dirs.lock().unwrap_or_else(|e| e.into_inner()).contains(&key(p))
    }
    pub fn may_read(&self, p: &Path) -> bool {
        self.has_file(p)
    }
    /// A granted file, or a new PDF or PNG directly inside a granted folder. A folder grant never
    /// lets the page replace a file that's already there; once Proof has written a file, that file
    /// is granted, so exporting to the same folder again in the same session still works.
    pub fn may_write(&self, p: &Path) -> bool {
        if self.has_file(p) {
            return true;
        }
        let in_dir = p.parent().map(|d| self.has_dir(d)).unwrap_or(false);
        let ext = p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
        in_dir && DIR_EXT.contains(&ext.as_str()) && std::fs::symlink_metadata(p).is_err()
    }
}

/// What may be created in a folder chosen with the folder dialog: split pages and page images.
const DIR_EXT: &[&str] = &["pdf", "png"];

impl Grants {
}

// ---------------------------------------------------------------- recent files

const RECENT_MAX: usize = 8;

pub fn recent_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_config_dir().ok().map(|d| d.join("recent.json"))
}

pub fn recent_load(app: &tauri::AppHandle) -> Vec<String> {
    recent_file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .take(RECENT_MAX)
        .collect()
}

pub fn recent_store(app: &tauri::AppHandle, list: &[String]) {
    if let Some(f) = recent_file(app) {
        if let Some(d) = f.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(f, serde_json::to_string(list).unwrap_or_else(|_| "[]".into()));
    }
}

/// Put a path at the top of the list. Same path in a different case counts as the same file.
pub fn recent_push(list: &mut Vec<String>, path: &str) {
    let k = key(Path::new(path));
    list.retain(|p| key(Path::new(p)) != k);
    list.insert(0, path.to_string());
    list.truncate(RECENT_MAX);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_granted_paths() {
        let g = Grants::default();
        let f = Path::new("/home/me/Docs/form.pdf");
        assert!(!g.may_read(f) && !g.may_write(f));
        g.file(f);
        assert!(g.may_read(f) && g.may_write(f));
        assert!(!g.may_read(Path::new("/home/me/Docs/other.pdf")));
        g.dir(Path::new("/home/me/Out/"));
        assert!(g.may_write(Path::new("/home/me/Out/p-001.pdf")));
        assert!(!g.may_read(Path::new("/home/me/Out/p-001.pdf")));
        assert!(!g.may_write(Path::new("/home/me/Out/sub/p-001.pdf")));
        assert!(!g.may_write(Path::new("/home/me/p-001.pdf")));
        assert!(!g.may_write(Path::new("/home/me/Out/form.docm")));
        assert!(!g.may_write(Path::new("/home/me/Out/x.json")));
    }

    #[test]
    fn folder_grant_never_overwrites() {
        let d = std::env::temp_dir().join(format!("proof-grants-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let existing = d.join("old.pdf");
        std::fs::write(&existing, b"x").unwrap();
        let g = Grants::default();
        g.dir(&d);
        assert!(!g.may_write(&existing));
        assert!(g.may_write(&d.join("new.pdf")));
        g.file(&existing);
        assert!(g.may_write(&existing));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn recent_order() {
        let mut l = vec![];
        for i in 0..10 { recent_push(&mut l, &format!("/x/{i}.pdf")); }
        recent_push(&mut l, "/x/5.pdf");
        assert_eq!(l.len(), RECENT_MAX);
        assert_eq!(l[0], "/x/5.pdf");
        assert_eq!(l.iter().filter(|p| *p == "/x/5.pdf").count(), 1);
    }
}

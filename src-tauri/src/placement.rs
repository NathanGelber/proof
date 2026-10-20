//! Where Proof's windows go and how big they are.
//!
//! Windows start hidden, are placed here, then shown, so they never flash in the wrong spot.
//! The first window restores last time's size and position if that spot is still on a screen; otherwise it opens
//! centred on the screen the mouse is on. Later windows open on the screen the mouse is on, stepped down from the
//! window they came from when that's on the same screen. Every window is kept inside its screen's work area (the
//! part the taskbar doesn't cover), and the minimum size shrinks for screens too small for it.
//! The last window to close is the one remembered.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

/// Default and minimum inner size, in logical pixels.
const DEFAULT: (f64, f64) = (1360.0, 880.0);
const MIN: (f64, f64) = (940.0, 580.0);

/// The window's normal (not maximized) rectangle, remembered between runs.
/// Position is the outer top-left in physical pixels; size is the inner size in physical pixels at `scale`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Saved {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    scale: f64,
    maximized: bool,
}

/// Latest known state of each open window, and which one was used last.
#[derive(Default)]
pub struct WindowMemory(Mutex<Mem>);

#[derive(Default)]
struct Mem {
    by_label: HashMap<String, Saved>,
    focused: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

impl Rect {
    fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && py >= self.y && (px as i64) < self.x as i64 + self.w as i64 && (py as i64) < self.y as i64 + self.h as i64
    }
}

fn work_area(m: &Monitor) -> Rect {
    let r = m.work_area();
    Rect { x: r.position.x, y: r.position.y, w: r.size.width, h: r.size.height }
}

/// Shrinks `r` to fit inside `area`, then moves it the least distance that puts it fully inside.
fn fit(r: Rect, area: Rect) -> Rect {
    let w = r.w.min(area.w);
    let h = r.h.min(area.h);
    let x = r.x.clamp(area.x, area.x + (area.w - w) as i32);
    let y = r.y.clamp(area.y, area.y + (area.h - h) as i32);
    Rect { x, y, w, h }
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("window.json"))
}

fn load(app: &AppHandle) -> Option<Saved> {
    let s: Saved = serde_json::from_str(&std::fs::read_to_string(file(app)?).ok()?).ok()?;
    (s.w > 0 && s.h > 0 && s.scale.is_finite() && s.scale > 0.0).then_some(s)
}

fn store(app: &AppHandle, s: &Saved) {
    if let Some(f) = file(app) {
        if let Some(d) = f.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(f, serde_json::to_string(s).unwrap_or_default());
    }
}

/// The screen the mouse is on, else the primary screen, else any.
fn screen_under_cursor(w: &WebviewWindow) -> Option<Monitor> {
    let at = w.cursor_position().ok().and_then(|p| w.monitor_from_point(p.x, p.y).ok().flatten());
    at.or_else(|| w.primary_monitor().ok().flatten())
        .or_else(|| w.available_monitors().ok().and_then(|v| v.into_iter().next()))
}

/// The screen whose work area holds this point, if any.
fn screen_at(w: &WebviewWindow, px: i32, py: i32) -> Option<Monitor> {
    w.available_monitors().ok()?.into_iter().find(|m| work_area(m).contains(px, py))
}

/// The gap between the outer frame and the inner area, so outer-frame maths can use inner sizes.
fn frame(w: &WebviewWindow) -> (u32, u32) {
    match (w.outer_size(), w.inner_size()) {
        (Ok(o), Ok(i)) => (o.width.saturating_sub(i.width), o.height.saturating_sub(i.height)),
        _ => (0, 0),
    }
}

/// Lets the window go as small as the screen needs, but no smaller than the usual minimum where it fits.
fn set_min_for(w: &WebviewWindow, m: &Monitor) {
    let a = work_area(m);
    let s = m.scale_factor();
    let _ = w.set_min_size(Some(LogicalSize::new(MIN.0.min(a.w as f64 / s), MIN.1.min(a.h as f64 / s))));
}

/// Sets the inner size and outer position so the whole frame sits inside `m`'s work area.
fn place_on(w: &WebviewWindow, m: &Monitor, inner: (u32, u32), pos: Option<(i32, i32)>) {
    let a = work_area(m);
    let (fw, fh) = frame(w);
    let outer = Rect {
        x: pos.map_or(0, |p| p.0),
        y: pos.map_or(0, |p| p.1),
        w: inner.0 + fw,
        h: inner.1 + fh,
    };
    let mut r = fit(outer, a);
    if pos.is_none() {
        r.x = a.x + ((a.w - r.w) / 2) as i32;
        r.y = a.y + ((a.h - r.h) / 2) as i32;
    }
    set_min_for(w, m);
    let _ = w.set_size(PhysicalSize::new(r.w.saturating_sub(fw).max(1), r.h.saturating_sub(fh).max(1)));
    let _ = w.set_position(PhysicalPosition::new(r.x, r.y));
}

fn place_default(w: &WebviewWindow) {
    if let Some(m) = screen_under_cursor(w) {
        let s = m.scale_factor();
        place_on(w, &m, ((DEFAULT.0 * s).round() as u32, (DEFAULT.1 * s).round() as u32), None);
    }
}

/// Inner size for a new window on `m`: the size of the window it came from (its normal size if maximized),
/// else last time's, else the default. Kept in logical pixels across screens with different scaling.
fn size_for(app: &AppHandle, from: Option<&WebviewWindow>, m: &Monitor) -> (u32, u32) {
    let s = m.scale_factor();
    let base = from.and_then(|f| app.state::<WindowMemory>().0.lock().unwrap().by_label.get(f.label()).copied()).or_else(|| load(app));
    match base {
        Some(b) => {
            let k = s / b.scale;
            ((b.w as f64 * k).round() as u32, (b.h as f64 * k).round() as u32)
        }
        None => ((DEFAULT.0 * s).round() as u32, (DEFAULT.1 * s).round() as u32),
    }
}

/// Places a new hidden window and shows it. `from` is the window that was in use when it was asked for.
pub fn place_new(w: &WebviewWindow, from: Option<&WebviewWindow>) {
    if let Some(m) = screen_under_cursor(w) {
        let a = work_area(&m);
        let inner = size_for(w.app_handle(), from, &m);
        // Stepped down from the window it came from, if that one is on this screen and not maximized; else centred.
        let pos = from
            .filter(|f| !f.is_maximized().unwrap_or(false) && !f.is_minimized().unwrap_or(false))
            .and_then(|f| f.outer_position().ok())
            .filter(|p| a.contains(p.x.saturating_add(40), p.y.saturating_add(10)))
            .map(|p| {
                let step = (32.0 * m.scale_factor()).round() as i32;
                (p.x + step, p.y + step)
            });
        place_on(w, &m, inner, pos);
    }
    remember(w);
    let _ = w.show();
    let _ = w.set_focus();
}

/// Places the hidden first window at startup and shows it.
pub fn restore(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let saved = load(app);
    // Last time's spot counts only if the top-left of its title bar is still on a screen.
    let target = saved.and_then(|s| screen_at(&w, s.x.saturating_add(40), s.y.saturating_add(10)).map(|m| (s, m)));
    match target {
        Some((s, m)) => {
            // The size is kept in logical pixels across screens with different scaling.
            let k = m.scale_factor() / s.scale;
            let inner = ((s.w as f64 * k).round() as u32, (s.h as f64 * k).round() as u32);
            place_on(&w, &m, inner, Some((s.x, s.y)));
            // Remember the normal rectangle before maximizing, so un-maximizing goes back to it.
            remember(&w);
            if s.maximized {
                let _ = w.maximize();
            }
        }
        None => {
            place_default(&w);
            remember(&w);
        }
    }
    let _ = w.show();
    let _ = w.set_focus();
}

/// Brings a window to the front, e.g. when it takes files opened from Explorer. If it's no longer on any screen
/// (a monitor was unplugged or rearranged), it's moved to the screen the mouse is on.
pub fn bring_back(w: &WebviewWindow) {
    let _ = w.unminimize();
    let on_screen = w.outer_position().ok().is_some_and(|p| screen_at(w, p.x + 40, p.y + 10).is_some());
    if !on_screen {
        let _ = w.unmaximize();
        place_default(w);
    }
    let _ = w.show();
    let _ = w.set_focus();
}

/// Keeps a resized or rescaled window inside the screen it ended up on. Only shrinks; never moves it while
/// someone may be dragging it.
pub fn keep_inside(w: &WebviewWindow) {
    if w.is_maximized().unwrap_or(false) || w.is_minimized().unwrap_or(false) {
        return;
    }
    let Ok(Some(m)) = w.current_monitor() else { return };
    set_min_for(w, &m);
    let a = work_area(&m);
    let (fw, fh) = frame(w);
    if let Ok(i) = w.inner_size() {
        let (mw, mh) = (a.w.saturating_sub(fw), a.h.saturating_sub(fh));
        if i.width > mw || i.height > mh {
            let _ = w.set_size(PhysicalSize::new(i.width.min(mw).max(1), i.height.min(mh).max(1)));
        }
    }
}

/// Notes the window's current state. The normal rectangle is only updated while it's neither maximized nor
/// minimized, so restoring from maximized goes back to a sensible size.
pub fn remember(w: &WebviewWindow) {
    if w.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = w.is_maximized().unwrap_or(false);
    let now = if maximized { None } else { normal(w) };
    let mem = w.state::<WindowMemory>();
    let mut mem = mem.0.lock().unwrap();
    match (now, mem.by_label.get_mut(w.label())) {
        (Some(s), _) => {
            mem.by_label.insert(w.label().to_string(), s);
        }
        (None, Some(s)) => s.maximized = maximized,
        (None, None) => {}
    }
}

fn normal(w: &WebviewWindow) -> Option<Saved> {
    let (p, i, scale) = (w.outer_position().ok()?, w.inner_size().ok()?, w.scale_factor().ok()?);
    Some(Saved { x: p.x, y: p.y, w: i.width, h: i.height, scale, maximized: false })
}

/// Notes which window is in use, so files opened from Explorer go to it.
pub fn set_focused(w: &tauri::Window) {
    w.state::<WindowMemory>().0.lock().unwrap().focused = Some(w.label().to_string());
}

/// The window used last, or any open window.
pub fn focused(app: &AppHandle) -> Option<WebviewWindow> {
    let label = app.state::<WindowMemory>().0.lock().unwrap().focused.clone();
    label.and_then(|l| app.get_webview_window(&l)).or_else(|| app.webview_windows().into_values().next())
}

/// A window closed: its state is written to disk, so the last one closed is what the next start restores.
pub fn closed(app: &AppHandle, label: &str) {
    let state = app.state::<WindowMemory>();
    let s = {
        let mut mem = state.0.lock().unwrap();
        if mem.focused.as_deref() == Some(label) {
            mem.focused = None;
        }
        mem.by_label.remove(label)
    };
    if let Some(s) = s {
        store(app, &s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect { x: 0, y: 0, w: 1920, h: 1040 };

    #[test]
    fn fits_inside_work_area() {
        // Already inside: unchanged.
        let r = Rect { x: 100, y: 100, w: 800, h: 600 };
        assert_eq!(fit(r, SCREEN), r);
        // Too big: shrunk to the screen and pulled in.
        assert_eq!(fit(Rect { x: 50, y: 50, w: 2500, h: 1400 }, SCREEN), SCREEN);
        // Hanging off the right and bottom: moved back, size kept.
        assert_eq!(fit(Rect { x: 1700, y: 900, w: 800, h: 600 }, SCREEN), Rect { x: 1120, y: 440, w: 800, h: 600 });
        // On a screen to the left of the primary one (negative coordinates).
        let left = Rect { x: -1280, y: 0, w: 1280, h: 680 };
        assert_eq!(fit(Rect { x: -200, y: 10, w: 1360, h: 880 }, left), left);
    }

    #[test]
    fn point_on_screen() {
        assert!(SCREEN.contains(0, 0));
        assert!(SCREEN.contains(1919, 1039));
        assert!(!SCREEN.contains(1920, 0));
        assert!(!SCREEN.contains(-1, 5));
    }
}

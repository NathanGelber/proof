// Everything that touches the operating system goes through here.
// Inside the Tauri app it uses native dialogs and real file paths; in a plain browser
// (used for development and testing) it falls back to file inputs and downloads.

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let core, winApi, webviewApi, eventApi;
if (isDesktop) {
  [core, winApi, webviewApi, eventApi] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/window'),
    import('@tauri-apps/api/webview'),
    import('@tauri-apps/api/event'),
  ]);
}

/** This window's name. Files opened from Explorer or dropped are sent to one window only. */
export const windowLabel = isDesktop ? winApi.getCurrentWindow().label : 'main';
const listenHere = (name, cb) => eventApi.listen(name, cb, { target: windowLabel });

const PDF_EXT = ['pdf', 'png', 'jpg', 'jpeg'], OFFICE_EXT = ['docx', 'xlsx', 'docm', 'xlsm'];
const openFilters = office => [{ name: office ? 'PDFs, Word and Excel forms' : 'PDFs and images', extensions: office ? [...PDF_EXT, ...OFFICE_EXT] : PDF_EXT }];
export const baseName = p => p.split(/[\\/]/).pop();
export const dirName = p => { const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')); return i > 0 ? p.slice(0, i) : ''; };
export const joinPath = (dir, name) => dir + (dir.includes('\\') ? '\\' : '/') + name;
export const mimeOf = name => /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.(docx|docm)$/i.test(name) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : /\.(xlsx|xlsm)$/i.test(name) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf';

/**
 * File dialogs run in the app itself, which then lets Proof use only the paths they return
 * (and files opened from Explorer, dropped on the window, or on the recent list).
 * Resolves an array of paths; empty when cancelled.
 */
export async function pickPaths({ multiple = false, title = null, filters = [] } = {}) {
  return core.invoke('pick_open', { title, filters, multiple });
}

export async function readPath(path) {
  const buf = await core.invoke('read_file', { path });
  return new Uint8Array(buf);
}

/** Let the person choose files to open. Resolves [{name, path, type, bytes}] (empty when cancelled). */
export async function pickOpen({ multiple = true, title, office = false } = {}) {
  if (isDesktop) {
    const paths = await pickPaths({ multiple, title: title || null, filters: openFilters(office) });
    return Promise.all(paths.map(async path => ({ name: baseName(path), path, type: mimeOf(path), bytes: await readPath(path) })));
  }
  return new Promise(resolve => {
    const inp = Object.assign(document.createElement('input'), { type: 'file', multiple, accept: 'application/pdf,.pdf,image/png,image/jpeg' + (office ? ',.docx,.xlsx,.docm,.xlsm' : '') });
    inp.onchange = async () => resolve(await Promise.all([...inp.files].map(fileEntry)));
    inp.oncancel = () => resolve([]);
    inp.click();
  });
}
async function fileEntry(f) { return { name: f.name, path: null, type: f.type || mimeOf(f.name), bytes: new Uint8Array(await f.arrayBuffer()) }; }

export async function pickImage() {
  if (isDesktop) {
    const [path] = await pickPaths({ filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }] });
    if (!path) return null;
    return { name: baseName(path), type: mimeOf(path), bytes: await readPath(path) };
  }
  const [f] = await new Promise(resolve => {
    const inp = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/png,image/jpeg' });
    inp.onchange = async () => resolve(await Promise.all([...inp.files].map(fileEntry)));
    inp.oncancel = () => resolve([]);
    inp.click();
  });
  return f || null;
}

/** Ask where to save. Resolves a path, or null when cancelled. In the browser, a pseudo path. */
export async function pickSave(defaultPath, { name = 'PDF document', ext = 'pdf' } = {}) {
  if (isDesktop) return (await core.invoke('pick_save', { defaultPath: defaultPath || null, name, ext })) || null;
  return 'download:' + baseName(defaultPath || 'document.' + ext);
}
export async function pickFolder(title) {
  if (isDesktop) return (await core.invoke('pick_folder', { title: title || null })) || null;
  return 'download:';
}

export async function writePath(path, bytes) {
  if (path.startsWith('download:')) {
    const name = path.slice(9);
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(name) }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    return;
  }
  await core.invoke('write_file', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
}
export const folderJoin = (folder, name) => folder.startsWith('download:') ? 'download:' + name : joinPath(folder, name);

/** A Unicode TrueType font from the system (Arial on Windows), or null. */
const fontPs = {};
/** The system's Arial (or Segoe UI), regular or bold, for text written into PDFs. null when there is none. */
export function systemFont(bold = false) {
  const k = bold ? 'b' : 'r';
  if (!fontPs[k]) fontPs[k] = isDesktop ? core.invoke('system_font', { bold }).then(b => (b && b.byteLength ? new Uint8Array(b) : null)).catch(() => null) : Promise.resolve(null);
  return fontPs[k];
}

export async function launchFiles() { return isDesktop ? core.invoke('launch_files') : []; }
export function onEvent(name, cb) { if (isDesktop) eventApi.listen(name, e => cb(e.payload)); }
export function onOpenFiles(cb) { if (isDesktop) listenHere('open-files', e => cb(e.payload)); }
/** A new Proof window, empty or opening these paths (ones Proof already has access to). Desktop only. */
export const canOpenWindows = isDesktop;
export function newWindow(paths = []) { if (isDesktop) core.invoke('new_window', { paths }).catch(() => {}); }
/** Bring this window to the front (and back onto a screen if it's lost). */
export function toFront() { if (isDesktop) core.invoke('window_front').catch(() => {}); }

/** Files dropped onto the window. cb(entries) with {name, path, type, bytes}; hover(true/false) for the overlay. */
export function onDrop(cb, hover) {
  if (isDesktop) {
    webviewApi.getCurrentWebview().onDragDropEvent(async e => {
      const t = e.payload.type;
      if (t === 'enter' || t === 'over') hover(true);
      else if (t === 'leave' || t === 'drop') hover(false);
    });
    // The app hands over dropped files itself, after allowing Proof to read them.
    listenHere('dropped-files', async e => {
      const paths = (e.payload || []).filter(p => /\.(pdf|png|jpe?g|docx|xlsx|docm|xlsm)$/i.test(p));
      if (paths.length) cb(await Promise.all(paths.map(async path => ({ name: baseName(path), path, type: mimeOf(path), bytes: await readPath(path) }))));
    });
    return;
  }
  let depth = 0;
  const has = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => { if (!has(e)) return; e.preventDefault(); if (depth++ === 0) hover(true); });
  window.addEventListener('dragover', e => { if (has(e)) e.preventDefault(); });
  window.addEventListener('dragleave', e => { if (!has(e)) return; if (--depth <= 0) { depth = 0; hover(false); } });
  window.addEventListener('drop', async e => { if (!has(e)) return; e.preventDefault(); depth = 0; hover(false); cb(await Promise.all([...e.dataTransfer.files].map(fileEntry))); });
}

export function setTitle(t) { document.title = t; if (isDesktop) winApi.getCurrentWindow().setTitle(t).catch(() => {}); }

/** handler() resolves true to allow closing. */
export function onCloseRequested(handler) {
  if (isDesktop) {
    winApi.getCurrentWindow().onCloseRequested(async e => { if (!(await handler())) e.preventDefault(); });
  } else {
    window.addEventListener('beforeunload', e => { if (handler.dirty?.()) { e.preventDefault(); e.returnValue = ''; } });
  }
}
export async function closeWindow() { if (isDesktop) await winApi.getCurrentWindow().destroy(); }

// The recent list is kept by the app, which only adds files the person chose.
let recent = isDesktop ? await core.invoke('recent_list').catch(() => []) : [];
try { localStorage.removeItem('proof.recent'); } catch {} // the old copy in window storage
export function recentFiles() { return recent; }
export function addRecent(path) {
  if (!path || !isDesktop) return;
  core.invoke('recent_add', { path }).then(() => core.invoke('recent_list')).then(l => (recent = l)).catch(() => {});
}
export function forgetRecent(path) {
  recent = recent.filter(p => p !== path);
  if (isDesktop) core.invoke('recent_forget', { path }).catch(() => {});
}

/** Open a web or mail link from a document in the default browser or mail app. Other schemes are refused. */
export async function openUrl(url) {
  if (!/^(https?:\/\/|mailto:)/i.test(url)) return false;
  if (isDesktop) { const { openUrl: open } = await import('@tauri-apps/plugin-opener'); await open(url); }
  else window.open(url, '_blank', 'noopener');
  return true;
}

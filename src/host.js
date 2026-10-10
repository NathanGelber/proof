// Everything that touches the operating system goes through here.
// Inside the Tauri app it uses native dialogs and real file paths; in a plain browser
// (used for development and testing) it falls back to file inputs and downloads.

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let core, dialog, winApi, webviewApi, eventApi;
if (isDesktop) {
  [core, dialog, winApi, webviewApi, eventApi] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/api/window'),
    import('@tauri-apps/api/webview'),
    import('@tauri-apps/api/event'),
  ]);
}

const OPEN_FILTERS = [{ name: 'PDFs and images', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }];
export const baseName = p => p.split(/[\\/]/).pop();
export const dirName = p => { const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')); return i > 0 ? p.slice(0, i) : ''; };
export const joinPath = (dir, name) => dir + (dir.includes('\\') ? '\\' : '/') + name;
const mimeOf = name => /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'application/pdf';

export async function readPath(path) {
  const buf = await core.invoke('read_file', { path });
  return new Uint8Array(buf);
}

/** Let the person choose files to open. Resolves [{name, path, type, bytes}] (empty when cancelled). */
export async function pickOpen({ multiple = true, title } = {}) {
  if (isDesktop) {
    let res = await dialog.open({ multiple, title, filters: OPEN_FILTERS });
    if (!res) return [];
    const paths = Array.isArray(res) ? res : [res];
    return Promise.all(paths.map(async path => ({ name: baseName(path), path, type: mimeOf(path), bytes: await readPath(path) })));
  }
  return new Promise(resolve => {
    const inp = Object.assign(document.createElement('input'), { type: 'file', multiple, accept: 'application/pdf,.pdf,image/png,image/jpeg' });
    inp.onchange = async () => resolve(await Promise.all([...inp.files].map(fileEntry)));
    inp.oncancel = () => resolve([]);
    inp.click();
  });
}
async function fileEntry(f) { return { name: f.name, path: null, type: f.type || mimeOf(f.name), bytes: new Uint8Array(await f.arrayBuffer()) }; }

export async function pickImage() {
  if (isDesktop) {
    const path = await dialog.open({ multiple: false, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }] });
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
  if (isDesktop) return (await dialog.save({ defaultPath, filters: [{ name, extensions: [ext] }] })) || null;
  return 'download:' + baseName(defaultPath || 'document.' + ext);
}
export async function pickFolder(title) {
  if (isDesktop) return (await dialog.open({ directory: true, title })) || null;
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

let fontP = null;
/** A Unicode TrueType font from the system (Arial on Windows), or null. */
export function systemFont() {
  if (!fontP) fontP = isDesktop ? core.invoke('system_font').then(b => (b && b.byteLength ? new Uint8Array(b) : null)).catch(() => null) : Promise.resolve(null);
  return fontP;
}

export async function launchFiles() { return isDesktop ? core.invoke('launch_files') : []; }
export function onOpenFiles(cb) { if (isDesktop) eventApi.listen('open-files', e => cb(e.payload)); }

/** Files dropped onto the window. cb(entries) with {name, path, type, bytes}; hover(true/false) for the overlay. */
export function onDrop(cb, hover) {
  if (isDesktop) {
    webviewApi.getCurrentWebview().onDragDropEvent(async e => {
      const t = e.payload.type;
      if (t === 'enter' || t === 'over') hover(true);
      else if (t === 'leave') hover(false);
      else if (t === 'drop') {
        hover(false);
        const paths = (e.payload.paths || []).filter(p => /\.(pdf|png|jpe?g)$/i.test(p));
        if (paths.length) cb(await Promise.all(paths.map(async path => ({ name: baseName(path), path, type: mimeOf(path), bytes: await readPath(path) }))));
      }
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

const RECENT = 'proof.recent';
export function recentFiles() { try { return JSON.parse(localStorage.getItem(RECENT) || '[]'); } catch { return []; } }
export function addRecent(path) {
  if (!path) return;
  try { const list = recentFiles().filter(p => p !== path); list.unshift(path); localStorage.setItem(RECENT, JSON.stringify(list.slice(0, 8))); } catch {}
}
export function forgetRecent(path) { try { localStorage.setItem(RECENT, JSON.stringify(recentFiles().filter(p => p !== path))); } catch {} }

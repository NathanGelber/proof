import '@fontsource-variable/archivo/wdth.css';
import '@fontsource/spline-sans-mono/400.css';
import '@fontsource/spline-sans-mono/500.css';
import '@fontsource/spline-sans-mono/600.css';
import '@fontsource/mrs-saint-delafield/400.css';
import './style.css';
import Sortable from 'sortablejs';
import * as host from './host.js';
import { initKyc, formSection, openProfile, openOfficeForm } from './kyc/ui.js';
import { isOfficeName } from './kyc/office.js';
import { pdfjsLib, mupdf, prepare, inspect, imageToPdf, compose, finalize, renderPngs, splitPages, blankPdf, samplePdf, Cancelled } from './engine.js';

mupdf(); // start loading the engine in the background

// ---------------------------------------------------------------- state
const DPR = () => Math.min(window.devicePixelRatio || 1, 2);
const PT = 96 / 72; // CSS px per point at 100%
const FILE_COLORS = ['--f1', '--f2', '--f3', '--f4', '--f5', '--f6'];
const SIG_KEY = 'proof.signature';
let uidN = 0; const uid = () => 'u' + (++uidN);
const defaultStamps = () => ({ header: { text: '', slot: 'tl' }, footer: { text: '', slot: 'bl' }, num: { fmt: 'off', slot: 'bc', start: 1 }, bates: { on: false, prefix: '', start: 1, digits: 6, slot: 'br' }, wm: { text: '', opacity: 0.15 } });

const S = {
  docs: [], pages: [], sel: new Set(), anchor: null, cur: null,
  tool: 'select', selItem: null, zoom: 'fit', itab: 'page',
  stamps: defaultStamps(), opts: { strip: true, compress: true, password: '', flatten: false },
  undo: [], redo: [], dirty: false, path: null, title: '', colorN: 0,
};

// ---------------------------------------------------------------- helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}
let toastT;
function toast(msg, ms = 3600) {
  $('.toast')?.remove(); clearTimeout(toastT);
  const t = h('div', { class: 'toast', role: 'status' }, msg); document.body.append(t);
  toastT = setTimeout(() => t.remove(), ms);
}
function busy(msg) {
  const b = h('div', { class: 'busy' }, h('div', {}, msg)); document.body.append(b);
  return { set: m => (b.firstChild.textContent = m), done: () => b.remove() };
}
function modal(title, ...body) {
  const scrim = h('div', { class: 'scrim' }); const m = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', {}, title), ...body);
  scrim.append(m); document.body.append(scrim);
  const close = () => { scrim.remove(); document.removeEventListener('keydown', esc, true); };
  const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); scrim.dispatchEvent(new Event('cancel')); } };
  document.addEventListener('keydown', esc, true);
  setTimeout(() => (m.querySelector('input:not([type=checkbox]):not([type=radio]),.primary') || m).focus?.(), 20);
  return { scrim, modal: m, close };
}
const pageNo = p => S.pages.indexOf(p) + 1;
const byUid = u => S.pages.find(p => p.uid === u);
const curPage = () => byUid(S.cur);
const shortName = n => (n.length > 34 ? n.slice(0, 22) + '…' + n.slice(-9) : n);
const today = () => new Date().toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
const visDocs = () => S.docs.filter(d => !d.hidden && S.pages.some(p => p.doc === d));
const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
const editCount = () => S.pages.reduce((a, p) => a + p.items.length, 0) + visDocs().reduce((a, d) => a + Object.keys(d.values).length, 0);
const stampsActive = () => { const s = S.stamps; return !!(s.header.text.trim() || s.footer.text.trim() || s.num.fmt !== 'off' || s.bates.on || s.wm.text.trim()); };
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); return true; } catch { return false; } };
const blobToDataUrl = blob => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });

// ---------------------------------------------------------------- undo
const clonePages = ps => ps.map(p => ({ ...p, items: p.items.map(i => ({ ...i })) }));
function snap() { return { pages: clonePages(S.pages), values: S.docs.map(d => [d, { ...d.values }]), sel: [...S.sel], stamps: JSON.parse(JSON.stringify(S.stamps)), cur: S.cur }; }
function commit(s = snap()) { S.undo.push(s); if (S.undo.length > 200) S.undo.shift(); S.redo.length = 0; markDirty(); }
function restore(s) {
  S.pages = clonePages(s.pages);
  for (const [d, v] of s.values) d.values = { ...v };
  S.sel = new Set(s.sel.filter(byUid)); S.stamps = JSON.parse(JSON.stringify(s.stamps));
  S.cur = byUid(s.cur) ? s.cur : S.pages[0]?.uid || null; S.selItem = null;
  markDirty(); renderAll();
}
function undo() { if (!S.undo.length) return; S.redo.push(snap()); restore(S.undo.pop()); }
function redo() { if (!S.redo.length) return; S.undo.push(snap()); restore(S.redo.pop()); }
function armUndo(el) {
  let pend = null; el.addEventListener('focus', () => (pend = snap()));
  const fire = () => { if (pend) { commit(pend); pend = null; } };
  el.addEventListener('input', fire); el.addEventListener('change', fire);
}
function markDirty() { S.dirty = S.pages.length > 0; updateChrome(); }

// ---------------------------------------------------------------- opening files
async function askPassword(name, attempt) {
  return new Promise(resolve => {
    const inp = h('input', { type: 'password', id: 'pw-in', autocomplete: 'off' });
    const m = modal('Password',
      h('p', {}, `${name} is protected. Enter its password to open it.`),
      attempt ? h('p', { class: 'msg' }, 'That password didn’t work. Try again.') : null,
      h('label', { class: 'fld', for: 'pw-in' }, h('span', { class: 'lbl' }, 'Password'), inp),
      h('div', { class: 'actions' }, h('button', { class: 'btn quiet', onclick: () => { m.close(); resolve(null); } }, 'Cancel'), h('button', { class: 'btn primary', onclick: ok }, 'Open')));
    function ok() { m.close(); resolve(inp.value); }
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
    m.scrim.addEventListener('cancel', () => resolve(null));
  });
}

/** Load one file entry into a doc. Returns the doc, or null if cancelled/failed. */
async function loadEntry(e, notes) {
  let bytes = e.bytes;
  if (/^image\//.test(e.type)) bytes = await imageToPdf(bytes, e.type);
  let prep;
  try { prep = await prepare(bytes, attempt => askPassword(e.name, attempt)); }
  catch (err) { if (!(err instanceof Cancelled)) notes.push(`${e.name}: ${err.message}`); return null; }
  const pdf = await pdfjsLib.getDocument({ data: prep.bytes.slice(), isEvalSupported: false }).promise;
  const proxies = []; for (let i = 0; i < pdf.numPages; i++) proxies.push(await pdf.getPage(i + 1));
  const info = await inspect(prep.bytes);
  if (prep.unlocked && !prep.password) notes.push(`${e.name} had editing restrictions. They’re removed in what you save.`);
  if (prep.repaired) notes.push(`${e.name} was damaged and has been repaired.`);
  return { id: uid(), name: e.name, path: e.path, bytes: prep.bytes, password: prep.password, pdf, proxies, fields: info.fields, xfa: info.xfa, values: {}, color: FILE_COLORS[S.colorN++ % FILE_COLORS.length], hidden: !!e.hidden, sample: !!e.sample };
}
function pagesOf(d) { return d.proxies.map((_, i) => ({ uid: uid(), doc: d, idx: i, rot: 0, items: [] })); }

async function confirmDiscard(what = 'opening another file') {
  if (!S.dirty) return true;
  const r = await askUnsaved(what);
  if (r === 'cancel') return false;
  if (r === 'save') return save();
  return true;
}
function askUnsaved(what) {
  return new Promise(resolve => {
    const m = modal('Unsaved changes',
      h('p', {}, `Save changes to ${S.title || 'this document'} before ${what}?`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn quiet', onclick: () => { m.close(); resolve('cancel'); } }, 'Cancel'),
        h('button', { class: 'btn', onclick: () => { m.close(); resolve('discard'); } }, 'Don’t save'),
        h('button', { class: 'btn primary', onclick: () => { m.close(); resolve('save'); } }, 'Save')));
    m.scrim.addEventListener('cancel', () => resolve('cancel'));
  });
}
function resetWorkspace() {
  for (const d of S.docs) d.pdf.destroy?.();
  S.docs = []; S.pages = []; S.sel.clear(); S.cur = null; S.selItem = null; S.undo = []; S.redo = [];
  S.stamps = defaultStamps(); S.opts.password = ''; S.path = null; S.title = ''; S.dirty = false; S.colorN = 0;
  pvs.clear(); thumbs.clear(); $('#pages').replaceChildren(); $('#thumbs').replaceChildren();
}

/** Open entries as a new document (replacing the current one). */
/** Word and Excel forms go straight to Fill from profile. Returns the entries that are left. */
async function takeOffice(entries) {
  const off = entries.filter(e => isOfficeName(e.name)); if (!off.length) return entries;
  if (off.length > 1) toast(`Opening ${off[0].name}. Word and Excel forms are filled one at a time.`, 5000);
  await openOfficeForm(off[0]);
  return entries.filter(e => !isOfficeName(e.name));
}

async function openEntries(entries) {
  entries = await takeOffice(entries);
  if (!entries.length) return;
  if (!(await confirmDiscard())) return;
  const b = busy('Opening…'); const notes = []; const loaded = [];
  try {
    for (const e of entries) { b.set('Opening ' + shortName(e.name) + '…'); const d = await loadEntry(e, notes); if (d) loaded.push(d); }
  } finally { b.done(); }
  if (!loaded.length) { if (notes.length) toast(notes.join(' '), 6000); return; }
  resetWorkspace();
  for (const d of loaded) { d.color = FILE_COLORS[S.colorN++ % FILE_COLORS.length]; S.docs.push(d); S.pages.push(...pagesOf(d)); }
  const first = entries[0];
  const single = loaded.length === 1 && first.path && /\.pdf$/i.test(first.path);
  S.path = single ? first.path : null;
  S.title = single ? first.name : loaded.length === 1 ? loaded[0].name.replace(/\.(png|jpe?g)$/i, '.pdf') : 'Combined.pdf';
  if (loaded.length === 1 && loaded[0].password) { S.opts.password = loaded[0].password; notes.push('Saving keeps the same open password. Change it under Document.'); }
  for (const e of entries) host.addRecent(e.path);
  S.cur = S.pages[0]?.uid || null; S.dirty = loaded.length > 1 || !single;
  S.zoom = 'fit'; renderAll(); $('#view').scrollTop = 0;
  if (notes.length) toast(notes.join(' '), 6500);
}

/** Insert entries' pages after the selection / current page, or at the end. */
async function insertEntries(entries, at) {
  entries = await takeOffice(entries);
  if (!entries.length) return;
  if (!S.pages.length) return openEntries(entries);
  const b = busy('Opening…'); const notes = []; const loaded = [];
  try { for (const e of entries) { b.set('Opening ' + shortName(e.name) + '…'); const d = await loadEntry(e, notes); if (d) loaded.push(d); } }
  finally { b.done(); }
  if (!loaded.length) { if (notes.length) toast(notes.join(' '), 6000); return; }
  commit();
  if (at == null) at = insertionPoint();
  const added = loaded.flatMap(d => { S.docs.push(d); return pagesOf(d); });
  S.pages.splice(at, 0, ...added);
  S.sel = new Set(added.map(p => p.uid)); S.cur = added[0].uid;
  for (const e of entries) host.addRecent(e.path);
  renderAll(); scrollToPage(S.cur);
  toast(`Inserted ${added.length} page${added.length > 1 ? 's' : ''} at position ${at + 1}.` + (notes.length ? ' ' + notes.join(' ') : ''), notes.length ? 6500 : 3600);
}
function insertionPoint() {
  if (S.sel.size) return Math.max(...S.pages.map((p, i) => (S.sel.has(p.uid) ? i : -1))) + 1;
  const c = curPage(); return c ? pageNo(c) : S.pages.length;
}
async function openPaths(paths, mode) {
  const entries = [];
  for (const path of paths) {
    try { entries.push({ name: host.baseName(path), path, type: host.mimeOf(path), bytes: await host.readPath(path) }); }
    catch (e) { toast(`Couldn’t open ${host.baseName(path)}: ${e?.message || e}`, 5000); host.forgetRecent(path); }
  }
  if (!entries.length) return;
  if (mode === 'insert') return insertEntries(entries);
  if (mode === 'ask' && S.pages.length && !entries.every(e => isOfficeName(e.name))) {
    const choice = await new Promise(resolve => {
      const m = modal('Open',
        h('p', {}, `Open ${entries.map(e => e.name).join(', ')} as its own document, or insert ${entries.length > 1 ? 'their' : 'its'} pages into ${S.title || 'the current document'}?`),
        h('div', { class: 'actions' },
          h('button', { class: 'btn quiet', onclick: () => { m.close(); resolve(null); } }, 'Cancel'),
          h('button', { class: 'btn', onclick: () => { m.close(); resolve('insert'); } }, 'Insert pages'),
          h('button', { class: 'btn primary', onclick: () => { m.close(); resolve('open'); } }, 'Open')));
      m.scrim.addEventListener('cancel', () => resolve(null));
    });
    if (!choice) return;
    return choice === 'insert' ? insertEntries(entries) : openEntries(entries);
  }
  return openEntries(entries);
}

// ---------------------------------------------------------------- saving
async function produce(pages, { password = S.opts.password } = {}, b) {
  return compose(pages, { flatten: S.opts.flatten, strip: S.opts.strip, stamps: stampsActive() ? stampLayout : null, compress: S.opts.compress, password }, t => b?.set(t));
}
function defaultSaveName(suffix = '') {
  const base = (S.title || 'Document.pdf').replace(/\.pdf$/i, '');
  return base + suffix + '.pdf';
}
function defaultSavePath(name) { return S.path ? host.joinPath(host.dirName(S.path), name) : name; }
function reportErrs(errs) { if (errs.length) setTimeout(() => toast(errs.slice(0, 2).join(' '), 8000), 3800); }

async function save(as = false) {
  if (!S.pages.length) return false;
  let path = !as && S.path;
  if (!path) { path = await host.pickSave(defaultSavePath(defaultSaveName(S.path ? '' : ''))); if (!path) return false; }
  const b = busy('Saving…');
  try {
    const { bytes, errs } = await produce(S.pages, {}, b);
    await host.writePath(path, bytes);
    b.done();
    if (!path.startsWith('download:')) { S.path = path; S.title = host.baseName(path); host.addRecent(path); }
    S.dirty = false; updateChrome();
    toast(`Saved ${S.title}.`); reportErrs(errs);
    return true;
  } catch (e) { b.done(); toast('Couldn’t save: ' + (e?.message || e), 7000); return false; }
}
async function exportSelected() {
  const pages = S.pages.filter(p => S.sel.has(p.uid)); if (!pages.length) { toast('Select pages in the sidebar first.'); return; }
  const path = await host.pickSave(defaultSavePath(defaultSaveName(`-pages`))); if (!path) return;
  const b = busy('Exporting…');
  try { const { bytes, errs } = await produce(pages, {}, b); await host.writePath(path, bytes); b.done(); toast(`Saved ${pages.length} page${pages.length > 1 ? 's' : ''} to ${host.baseName(path)}.`); reportErrs(errs); }
  catch (e) { b.done(); toast('Couldn’t export: ' + (e?.message || e), 7000); }
}
async function exportSplit() {
  if (!S.pages.length) return;
  const folder = await host.pickFolder('Choose a folder for the pages'); if (!folder) return;
  const stem = defaultSaveName().replace(/\.pdf$/i, '');
  const b = busy('Splitting…');
  try {
    const { bytes, errs } = await produce(S.pages, { password: '' }, b);
    const parts = await splitPages(bytes);
    for (let i = 0; i < parts.length; i++) {
      b.set(`Writing page ${i + 1} of ${parts.length}`);
      const part = S.opts.password ? await finalize(parts[i], { compress: false, strip: false, password: S.opts.password }) : parts[i];
      await host.writePath(host.folderJoin(folder, `${stem}-p${String(i + 1).padStart(3, '0')}.pdf`), part);
    }
    b.done(); toast(`Wrote ${parts.length} PDFs${folder.startsWith('download:') ? '' : ' to ' + folder}.`); reportErrs(errs);
  } catch (e) { b.done(); toast('Couldn’t split: ' + (e?.message || e), 7000); }
}
async function exportPng() {
  if (!S.pages.length) return;
  const pages = S.sel.size ? S.pages.filter(p => S.sel.has(p.uid)) : S.pages;
  const folder = await host.pickFolder('Choose a folder for the images'); if (!folder) return;
  const stem = defaultSaveName().replace(/\.pdf$/i, '');
  const b = busy('Rendering…');
  try {
    const { bytes, errs } = await produce(pages, { password: '' }, b);
    const pngs = await renderPngs(bytes, 150, (i, n) => b.set(`Rendering page ${i + 1} of ${n}`));
    for (let i = 0; i < pngs.length; i++) await host.writePath(host.folderJoin(folder, `${stem}-p${String(i + 1).padStart(3, '0')}.png`), pngs[i]);
    b.done(); toast(`Wrote ${pngs.length} PNG${pngs.length > 1 ? 's' : ''} at 150 dpi${folder.startsWith('download:') ? '' : ' to ' + folder}.`); reportErrs(errs);
  } catch (e) { b.done(); toast('Couldn’t export images: ' + (e?.message || e), 7000); }
}

// ---------------------------------------------------------------- stamps layout (shared by preview and output)
const SLOTS = [['tl', 'Top left'], ['tc', 'Top center'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['bc', 'Bottom center'], ['br', 'Bottom right']];
function stampLayout(k, N, W, H, measure) {
  const st = S.stamps, size = 9, lh = 11.5, m = 24, date = today();
  const sub = t => t.replace(/\{page\}/g, k + 1).replace(/\{pages\}/g, N).replace(/\{date\}/g, date);
  const groups = {}; const add = (slot, text) => { if (text) (groups[slot] ||= []).push(text); };
  if (st.header.text.trim()) add(st.header.slot, sub(st.header.text));
  if (st.num.fmt !== 'off') { const n = k + st.num.start, tot = N + st.num.start - 1; add(st.num.slot, st.num.fmt === 'n' ? String(n) : st.num.fmt === 'nofn' ? `${n} / ${tot}` : `Page ${n} of ${tot}`); }
  if (st.bates.on) add(st.bates.slot, st.bates.prefix + String(k + st.bates.start).padStart(st.bates.digits, '0'));
  if (st.footer.text.trim()) add(st.footer.slot, sub(st.footer.text));
  const lines = [];
  for (const [slot, arr] of Object.entries(groups)) {
    const top = slot[0] === 't', al = slot[1];
    arr.forEach((text, i) => {
      const w = measure(text, size);
      lines.push({ text, size, u: al === 'l' ? m : al === 'c' ? (W - w) / 2 : W - m - w, v: top ? H - m - size * 0.75 - i * lh : m + (arr.length - 1 - i) * lh });
    });
  }
  let wm = null; const wt = st.wm.text.trim();
  if (wt) { const size = Math.min(120, Math.hypot(W, H) * 0.5 / measure(wt, 1)); wm = { text: wt, size, opacity: st.wm.opacity, w: measure(wt, size) }; }
  return { lines, wm };
}
const mctx = document.createElement('canvas').getContext('2d');
const cssMeasure = (t, s) => { mctx.font = `${s}px Arial, Helvetica, sans-serif`; return mctx.measureText(t).width; };

// ---------------------------------------------------------------- page view
const pvs = new Map(); // uid -> {el, canvas, stamps, layer, vp, key}
const view = $('#view'), pagesEl = $('#pages');
const vpFor = (p, scale) => { const px = p.doc.proxies[p.idx]; return px.getViewport({ scale, rotation: (px.rotate + p.rot) % 360 }); };
function fitScale() {
  const cw = view.clientWidth - 48;
  const maxW = Math.max(1, ...S.pages.map(p => vpFor(p, 1).width));
  return Math.max(0.1, Math.min(6, cw / maxW));
}
const scaleNow = () => (S.zoom === 'fit' ? fitScale() : S.zoom * PT);
function pvFor(p) {
  let v = pvs.get(p.uid);
  if (!v) {
    const canvas = h('canvas'), stamps = h('div', { class: 'stamps' }), layer = h('div', { class: 'layer' });
    const el = h('div', { class: 'pv', 'data-uid': p.uid }, canvas, stamps, layer, h('span', { class: 'pn' }));
    v = { el, canvas, stamps, layer, vp: null, key: null, visible: false };
    pvs.set(p.uid, v); io.observe(el);
    el.addEventListener('contextmenu', e => pageMenu(e, p.uid));
  }
  return v;
}
const io = new IntersectionObserver(entries => {
  for (const en of entries) {
    const v = pvs.get(en.target.dataset.uid); if (!v) continue;
    v.visible = en.isIntersecting;
    if (v.visible) queueRender(en.target.dataset.uid);
    else if (v.key) { v.canvas.width = v.canvas.height = 0; v.key = null; }
  }
}, { root: view, rootMargin: '900px 0px' });

function layoutView(keepAnchor = true) {
  const scale = scaleNow();
  let anchor = null;
  if (keepAnchor && S.cur && pvs.get(S.cur)?.el.isConnected) {
    const el = pvs.get(S.cur).el; anchor = { uid: S.cur, ratio: (view.scrollTop - el.offsetTop) / Math.max(1, el.offsetHeight) };
  }
  const live = new Set(S.pages.map(p => p.uid));
  for (const [u, v] of pvs) if (!live.has(u)) { io.unobserve(v.el); v.el.remove(); pvs.delete(u); }
  const els = S.pages.map((p, i) => {
    const v = pvFor(p); const vp = vpFor(p, scale); v.vp = vp;
    v.el.style.width = vp.width + 'px'; v.el.style.height = vp.height + 'px';
    v.el.classList.toggle('cur', p.uid === S.cur);
    $('.pn', v.el).textContent = String(i + 1);
    drawItems(p); drawStamps(p, i);
    if (v.key && v.key !== renderKey(p, scale)) { v.canvas.style.width = vp.width + 'px'; v.canvas.style.height = vp.height + 'px'; }
    return v.el;
  });
  pagesEl.replaceChildren(...els);
  $('#empty').hidden = S.pages.length > 0;
  if (!S.pages.length) renderEmpty();
  if (anchor) {
    const el = pvs.get(anchor.uid)?.el;
    if (el) { view.scrollTop = el.offsetTop + anchor.ratio * el.offsetHeight; view.scrollLeft = el.offsetLeft + el.offsetWidth / 2 - view.clientWidth / 2; }
  }
  for (const p of S.pages) if (pvs.get(p.uid).visible) queueRender(p.uid);
  $('#zLbl').textContent = S.zoom === 'fit' ? 'Fit' : Math.round(S.zoom * 100) + '%';
}
const renderKey = (p, scale) => `${scale.toFixed(4)}|${p.rot}|${DPR()}`;
const rq = []; let rBusy = false;
function queueRender(u) { if (!rq.includes(u)) rq.push(u); pumpRender(); }
async function pumpRender() {
  if (rBusy) return; rBusy = true;
  while (rq.length) {
    const i = rq.findIndex(u => pvs.get(u)?.visible); const u = i >= 0 ? rq.splice(i, 1)[0] : rq.shift();
    const p = byUid(u), v = pvs.get(u); if (!p || !v || !v.visible) continue;
    const scale = scaleNow(), key = renderKey(p, scale); if (v.key === key) continue;
    try {
      const dpr = DPR(); const vp = vpFor(p, scale * dpr);
      const off = document.createElement('canvas'); off.width = Math.ceil(vp.width); off.height = Math.ceil(vp.height);
      await p.doc.proxies[p.idx].render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
      if (renderKey(p, scaleNow()) !== key) continue;
      v.canvas.width = off.width; v.canvas.height = off.height;
      v.canvas.style.width = vp.width / dpr + 'px'; v.canvas.style.height = vp.height / dpr + 'px';
      v.canvas.getContext('2d').drawImage(off, 0, 0); v.key = key;
    } catch {}
  }
  rBusy = false;
}
function setZoom(z) {
  S.zoom = z === 'fit' ? 'fit' : Math.max(0.25, Math.min(4, z));
  layoutView(); updateChrome();
}
const zoomNow = () => scaleNow() / PT;
const ZSTEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const zoomStep = dir => { const z = zoomNow(); setZoom(dir > 0 ? ZSTEPS.find(s => s > z + 0.001) || 4 : [...ZSTEPS].reverse().find(s => s < z - 0.001) || 0.25); };
$('#zIn').onclick = () => zoomStep(1); $('#zOut').onclick = () => zoomStep(-1);
$('#zLbl').onclick = () => setZoom(S.zoom === 'fit' ? 1 : 'fit');
view.addEventListener('wheel', e => { if (!e.ctrlKey) return; e.preventDefault(); zoomStep(e.deltaY < 0 ? 1 : -1); }, { passive: false });
let rzT; new ResizeObserver(() => { clearTimeout(rzT); rzT = setTimeout(() => { if (S.zoom === 'fit') layoutView(); }, 120); }).observe(view);

function scrollToPage(u) { const v = pvs.get(u); if (v?.el.isConnected) view.scrollTop = v.el.offsetTop - 16; }
let scT;
view.addEventListener('scroll', () => {
  if (scT) return;
  scT = requestAnimationFrame(() => {
    scT = null; const mid = view.scrollTop + view.clientHeight * 0.4; let best = null;
    for (const p of S.pages) { const el = pvs.get(p.uid)?.el; if (!el) continue; if (el.offsetTop <= mid) best = p.uid; else break; }
    if (best && best !== S.cur) setCur(best, false);
  });
});
function setCur(u, scroll = true) {
  const prev = S.cur; S.cur = u;
  pvs.get(prev)?.el.classList.remove('cur'); pvs.get(u)?.el.classList.add('cur');
  thumbs.get(prev)?.classList.remove('cur'); const t = thumbs.get(u); t?.classList.add('cur');
  t?.scrollIntoView({ block: 'nearest' });
  if (scroll) scrollToPage(u);
  if (S.itab === 'page' && !S.selItem) renderInsp();
  updateChrome();
}

function drawStamps(p, i = S.pages.indexOf(p)) {
  const v = pvs.get(p.uid); if (!v?.vp) return; const L = v.stamps; L.replaceChildren();
  if (!stampsActive()) return;
  const sc = v.vp.scale, W = v.vp.width / sc, H = v.vp.height / sc;
  const { lines, wm } = stampLayout(i, S.pages.length, W, H, cssMeasure);
  for (const l of lines) L.append(h('div', { style: `left:${l.u * sc}px;top:${(H - l.v - l.size * 0.8) * sc}px;font-size:${l.size * sc}px` }, l.text));
  if (wm) L.append(h('div', { class: 'wm', style: `left:${W / 2 * sc}px;top:${H / 2 * sc}px;font-size:${wm.size * sc}px;opacity:${wm.opacity}` }, wm.text));
}
const redrawStamps = () => S.pages.forEach((p, i) => drawStamps(p, i));

// ---------------------------------------------------------------- items on pages
const lineCount = it => (it.text || ' ').split('\n').length;
function positionEl(it, el, vp) {
  const [sx, sy] = vp.convertToViewportPoint(it.x, it.y);
  const hp = it.type === 'text' ? lineCount(it) * it.size * 1.2 * vp.scale : it.h * vp.scale;
  el.style.left = sx + 'px'; el.style.top = sy - hp + 'px'; el.style.height = hp + 'px';
  if (it.type === 'text') el.style.fontSize = it.size * vp.scale + 'px'; else el.style.width = it.w * vp.scale + 'px';
  el.style.transform = `rotate(${(vp.rotation - it.theta + 360) % 360}deg)`;
}
function drawItems(p) {
  const v = pvs.get(p.uid); if (!v?.vp) return; v.layer.replaceChildren();
  for (const it of p.items) {
    let el;
    if (it.type === 'text') { el = h('div', { class: 'it text' + (it.text ? '' : ' empty'), style: `color:${it.color}` }); el.textContent = it.text; }
    else if (it.type === 'rect') el = h('div', { class: 'it rect', style: `background:${it.color}` });
    else if (it.type === 'redact') el = h('div', { class: 'it redact', title: 'Redaction: removed when you save' });
    else el = h('div', { class: 'it img' }, h('img', { src: it.src, alt: '' }));
    el.dataset.id = it.id;
    if (S.selItem?.id === it.id) { el.classList.add('on'); if (it.type !== 'text') el.append(h('i', { class: 'grip', 'data-grip': '1' })); }
    positionEl(it, el, v.vp); v.layer.append(el);
  }
}
function selectItem(u, id) {
  const prev = S.selItem; S.selItem = id ? { uid: u, id } : null;
  if (prev && prev.uid !== u) { const pp = byUid(prev.uid); if (pp) drawItems(pp); }
  const p = byUid(u); if (p) drawItems(p);
  if (id) { if (u !== S.cur) setCur(u, false); S.itab = 'page'; renderTabs(); }
  renderInsp();
}
function findItem() { const s = S.selItem; if (!s) return {}; const p = byUid(s.uid); return { p, it: p?.items.find(i => i.id === s.id) }; }
function addItem(p, it) {
  commit(); it.id = uid(); it.theta = (p.doc.proxies[p.idx].rotate + p.rot) % 360; p.items.push(it);
  setTool('select'); selectItem(p.uid, it.id); updateThumb(p); updateChrome(); return it;
}
function deleteItem() {
  const { p } = findItem(); if (!p) return; commit();
  p.items = p.items.filter(i => i.id !== S.selItem.id); S.selItem = null; drawItems(p); renderInsp(); updateThumb(p); updateChrome();
}
function setTool(t) {
  S.tool = t; $$('#tools button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.t === t)));
  view.classList.toggle('place', ['text', 'date', 'cover', 'redact'].includes(t));
  if (S.itab === 'page' && !S.selItem) renderInsp();
}
const TOOL_HINT = {
  select: 'Click something you added to select it. Drag to move, drag the blue square to resize, arrow keys nudge.',
  text: 'Click the page where the text should start, then type in the inspector.',
  date: `Click the page to stamp today’s date (${today()}).`,
  cover: 'Click to place a box that hides what’s under it. The covered text stays in the file; use Redact to remove it.',
  redact: 'Click to place a redaction, then resize it over what should go. When you save, everything underneath (text, images) is removed and a black box is left in its place.',
  image: 'Choose a PNG or JPG. It lands in the middle of the visible page.',
  sign: 'Draw, type, or reuse your saved signature. It lands in the middle of the visible page.',
};
$('#tools').addEventListener('click', e => { const t = e.target.closest('button')?.dataset.t; if (t) useTool(t); });
async function useTool(t) {
  if (!S.pages.length) return;
  if (t === 'image') {
    const f = await host.pickImage(); if (!f) return;
    const src = await blobToDataUrl(new Blob([f.bytes], { type: f.type }));
    const img = new Image(); img.onload = () => placeCentered(src, img.width / img.height); img.src = src; return;
  }
  if (t === 'sign') { openSign(); return; }
  setTool(t);
}
/** Place an image item in the middle of the visible part of the current page. */
function placeCentered(src, aspect) {
  const p = curPage(); const v = pvs.get(p.uid); const vp = v.vp, sc = vp.scale;
  const vr = view.getBoundingClientRect(), pr = v.el.getBoundingClientRect();
  const top = Math.max(vr.top, pr.top), bot = Math.min(vr.bottom, pr.bottom);
  const cx = pr.width / 2, cy = (top + bot) / 2 - pr.top;
  const w = Math.min(200, (vp.width / sc) * 0.4), ht = w / aspect;
  const [x, y] = vp.convertToPdfPoint(cx - (w * sc) / 2, Math.min(pr.height, cy + (ht * sc) / 2));
  addItem(p, { type: 'img', x, y, w, h: ht, src, aspect });
}

let drag = null;
pagesEl.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const pvEl = e.target.closest('.pv'); if (!pvEl) return;
  const p = byUid(pvEl.dataset.uid), v = pvs.get(p.uid), vp = v.vp;
  const r = v.layer.getBoundingClientRect(); const cx = e.clientX - r.left, cy = e.clientY - r.top;
  const el = e.target.closest('.it');
  if (S.cur !== p.uid) setCur(p.uid, false);
  if (el && S.tool === 'select') {
    const it = p.items.find(i => i.id === el.dataset.id); if (!it) return;
    e.preventDefault(); view.focus({ preventScroll: true });
    if (S.selItem?.id !== it.id) selectItem(p.uid, it.id);
    const target = v.layer.querySelector(`.it[data-id="${it.id}"]`);
    const [ox, oy] = vp.convertToViewportPoint(it.x, it.y);
    drag = { p, it, vp, el: target, mode: e.target.dataset.grip ? 'resize' : 'move', sx: e.clientX, sy: e.clientY, ox, oy, w0: it.w, h0: it.h, pend: snap() };
    pagesEl.setPointerCapture(e.pointerId); return;
  }
  if (S.tool === 'text' || S.tool === 'date') {
    const isDate = S.tool === 'date', size = isDate ? 11 : 14;
    const [x, y] = vp.convertToPdfPoint(cx, cy + size * 1.2 * vp.scale);
    addItem(p, { type: 'text', x, y, text: isDate ? today() : '', size, color: '#111111' });
    if (!isDate) setTimeout(() => $('#insp-text')?.focus(), 30);
    return;
  }
  if (S.tool === 'cover' || S.tool === 'redact') {
    const w = 150, ht = 22; const [x, y] = vp.convertToPdfPoint(cx, cy + ht * vp.scale);
    addItem(p, S.tool === 'cover' ? { type: 'rect', x, y, w, h: ht, color: '#000000' } : { type: 'redact', x, y, w, h: ht });
    return;
  }
  if (S.selItem) selectItem(null, null);
});
pagesEl.addEventListener('pointermove', e => {
  if (!drag) return;
  if (drag.pend) { commit(drag.pend); drag.pend = null; }
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy, { it, vp } = drag, sc = vp.scale;
  if (drag.mode === 'move') [it.x, it.y] = vp.convertToPdfPoint(drag.ox + dx, drag.oy + dy);
  else {
    const phi = ((vp.rotation - it.theta) * Math.PI) / 180, c = Math.cos(phi), s = Math.sin(phi);
    it.w = Math.max(6, drag.w0 + (dx * c + dy * s) / sc);
    it.h = it.type === 'img' ? it.w / it.aspect : Math.max(4, drag.h0 + (dx * s - dy * c) / sc);
  }
  positionEl(it, drag.el, vp);
});
const endDrag = () => { if (drag && !drag.pend) { updateThumb(drag.p); renderInsp(); } drag = null; };
pagesEl.addEventListener('pointerup', endDrag); pagesEl.addEventListener('pointercancel', endDrag);
function nudge(dx, dy) {
  const { p, it } = findItem(); if (!it) return; const v = pvs.get(p.uid);
  commit(); const [sx, sy] = v.vp.convertToViewportPoint(it.x, it.y);
  [it.x, it.y] = v.vp.convertToPdfPoint(sx + dx * v.vp.scale, sy + dy * v.vp.scale); drawItems(p);
}

// ---------------------------------------------------------------- sidebar thumbnails
const thumbs = new Map();
const tq = []; let tBusy = false;
function queueThumb(p, canvas) { tq.push([p.uid, canvas]); pumpThumbs(); }
async function pumpThumbs() {
  if (tBusy) return; tBusy = true;
  while (tq.length) {
    const [u, canvas] = tq.shift(); const p = byUid(u); if (!p) continue;
    try {
      const v1 = vpFor(p, 1); const dpr = DPR(); const scale = Math.min(150 / v1.width, 200 / v1.height);
      const vp = vpFor(p, scale * dpr);
      const off = document.createElement('canvas'); off.width = Math.ceil(vp.width); off.height = Math.ceil(vp.height);
      await p.doc.proxies[p.idx].render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
      canvas.width = off.width; canvas.height = off.height; canvas.style.width = off.width / dpr + 'px'; canvas.style.height = off.height / dpr + 'px';
      canvas.getContext('2d').drawImage(off, 0, 0);
    } catch {}
  }
  tBusy = false;
}
function thumbFor(p) {
  let t = thumbs.get(p.uid);
  if (!t) {
    const canvas = h('canvas');
    t = h('div', { class: 'th', 'data-uid': p.uid }, h('div', { class: 'tc' }, canvas), h('div', { class: 'row' }, h('span', { class: 'n' }), h('i', { class: 'sw' }), h('span', { class: 'src' }), h('span', { class: 'ed' })));
    t._canvas = canvas; thumbs.set(p.uid, t);
    t.addEventListener('click', e => thumbClick(e, t.dataset.uid));
    t.addEventListener('contextmenu', e => { const u = t.dataset.uid; if (!S.sel.has(u)) { S.sel = new Set([u]); S.anchor = u; updateSel(); } pageMenu(e, u); });
  }
  updateThumb(p, t);
  return t;
}
function updateThumb(p, t = thumbs.get(p.uid)) {
  if (!t) return;
  $('.n', t).textContent = String(pageNo(p)).padStart(2, '0');
  $('.sw', t).style.background = p.doc.hidden ? 'var(--hair)' : `var(${p.doc.color})`;
  const src = $('.src', t); src.textContent = p.doc.hidden ? 'Blank' : `${p.doc.name} · ${p.idx + 1}`; src.title = p.doc.hidden ? 'Blank page' : p.doc.name;
  $('.ed', t).textContent = p.items.length ? '+' + p.items.length : '';
  t.classList.toggle('cur', p.uid === S.cur);
  if (t._rot !== p.rot) { t._rot = p.rot; queueThumb(p, t._canvas); }
}
function renderThumbs() {
  const live = new Set(S.pages.map(p => p.uid));
  for (const u of [...thumbs.keys()]) if (!live.has(u)) thumbs.delete(u);
  $('#thumbs').replaceChildren(...S.pages.map(thumbFor));
  $('#sideCount').textContent = S.pages.length; updateSel();
}
function thumbClick(e, u) {
  if (e.shiftKey && S.anchor) {
    const a = S.pages.findIndex(p => p.uid === S.anchor), b = S.pages.findIndex(p => p.uid === u);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    if (!e.ctrlKey) S.sel.clear();
    for (let i = lo; i <= hi; i++) S.sel.add(S.pages[i].uid);
  } else if (e.ctrlKey || e.metaKey) { S.sel.has(u) ? S.sel.delete(u) : S.sel.add(u); S.anchor = u; }
  else { S.sel = new Set([u]); S.anchor = u; }
  updateSel(); setCur(u, true);
}
function updateSel() {
  for (const [u, t] of thumbs) t.classList.toggle('sel', S.sel.has(u));
  if (S.itab === 'page' && !S.selItem) renderInsp();
  updateChrome();
}
let sortPend = null;
new Sortable($('#thumbs'), {
  animation: 120, delay: 120, delayOnTouchOnly: true,
  onStart() { sortPend = snap(); },
  onEnd(e) {
    if (e.oldIndex !== e.newIndex && sortPend) commit(sortPend); sortPend = null;
    S.pages = $$('#thumbs .th').map(t => byUid(t.dataset.uid)).filter(Boolean); renderAll();
  },
});

// ---------------------------------------------------------------- page operations
const targetPages = u => (S.sel.size ? S.pages.filter(p => S.sel.has(p.uid)) : [byUid(u || S.cur)].filter(Boolean));
function rotatePages(list, d) { if (!list.length) return; commit(); list.forEach(p => (p.rot = (p.rot + d + 360) % 360)); renderAll(); }
function deletePages(list) {
  if (!list.length) return; if (list.length === S.pages.length) { toast('A document needs at least one page.'); return; }
  commit(); const gone = new Set(list.map(p => p.uid)); const i = S.pages.findIndex(p => gone.has(p.uid));
  S.pages = S.pages.filter(p => !gone.has(p.uid)); S.sel.clear();
  if (!byUid(S.cur)) S.cur = (S.pages[Math.min(i, S.pages.length - 1)] || S.pages[0]).uid;
  if (S.selItem && !byUid(S.selItem.uid)) S.selItem = null;
  renderAll(); toast(`Deleted ${list.length} page${list.length > 1 ? 's' : ''}. Ctrl+Z brings ${list.length > 1 ? 'them' : 'it'} back.`);
}
function movePages(list, to) {
  if (!list.length) return; commit(); const set = new Set(list.map(p => p.uid));
  const rest = S.pages.filter(p => !set.has(p.uid)); S.pages = to === 'start' ? [...list, ...rest] : [...rest, ...list]; renderAll();
}
async function insertBlank(afterUid) {
  const ref = byUid(afterUid) || S.pages[S.pages.length - 1];
  const at = ref ? pageNo(ref) : 0; const v = ref ? vpFor(ref, 1) : { width: 595.28, height: 841.89 };
  const bytes = await blankPdf(v.width, v.height);
  const notes = []; const d = await loadEntry({ name: 'Blank page', path: null, type: 'application/pdf', bytes, hidden: true }, notes); if (!d) return;
  commit(); S.docs.push(d); const [p] = pagesOf(d); S.pages.splice(at, 0, p); S.cur = p.uid; S.sel = new Set([p.uid]);
  renderAll(); scrollToPage(p.uid); toast(`Inserted a blank page at position ${at + 1}.`);
}
const scopeIdx = () => (S.sel.size >= 2 ? S.pages.map((p, i) => (S.sel.has(p.uid) ? i : -1)).filter(i => i >= 0) : S.pages.map((_, i) => i));
function reversePages() {
  const idx = scopeIdx(); if (idx.length < 2) return; commit();
  const list = idx.map(i => S.pages[i]).reverse(); idx.forEach((i, k) => (S.pages[i] = list[k]));
  renderAll(); toast(`Reversed ${idx.length} pages.`);
}
function collatePages(revBacks) {
  const idx = scopeIdx(); if (idx.length < 2) return; commit();
  const list = idx.map(i => S.pages[i]); const f = Math.ceil(list.length / 2);
  const fronts = list.slice(0, f), backs = list.slice(f); if (revBacks) backs.reverse();
  const res = []; for (let i = 0; i < f; i++) { res.push(fronts[i]); if (backs[i]) res.push(backs[i]); }
  idx.forEach((i, k) => (S.pages[i] = res[k]));
  renderAll(); toast(`Collated ${idx.length} pages: ${f} fronts, ${list.length - f} backs.`);
}
function removeDoc(d) {
  if (S.pages.every(p => p.doc === d)) { toast('That’s the only file. Use Open to start over.'); return; }
  commit(); S.pages = S.pages.filter(p => p.doc !== d); for (const u of [...S.sel]) if (!byUid(u)) S.sel.delete(u);
  if (!byUid(S.cur)) S.cur = S.pages[0].uid; if (S.selItem && !byUid(S.selItem.uid)) S.selItem = null;
  renderAll();
}

// ---------------------------------------------------------------- menus
let menuEl = null;
function closeMenu() { menuEl?.remove(); menuEl = null; $$('[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false')); }
function showMenu(x, y, items, opener) {
  closeMenu();
  menuEl = h('div', { class: 'menu', role: 'menu' }, items.map(it => it === '-' ? h('hr') :
    h('button', { role: 'menuitem', class: it.danger ? 'danger' : null, disabled: it.disabled, onclick: () => { closeMenu(); it.action(); } }, h('span', {}, it.label), it.kbd ? h('kbd', {}, it.kbd) : null)));
  document.body.append(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(x, innerWidth - r.width - 8) + 'px'; menuEl.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  opener?.setAttribute('aria-expanded', 'true'); menuEl.querySelector('button:not(:disabled)')?.focus();
}
document.addEventListener('pointerdown', e => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
document.addEventListener('contextmenu', e => { if (!e.target.closest('input,textarea,.pv,.th')) e.preventDefault(); });
function pageMenu(e, u) {
  e.preventDefault();
  const onItem = e.target.closest('.it');
  if (onItem) {
    const p = byUid(u); selectItem(u, onItem.dataset.id);
    return showMenu(e.clientX, e.clientY, [{ label: 'Delete', kbd: 'Del', danger: true, action: deleteItem }]);
  }
  const list = targetPages(u); const n = list.length; const s = n > 1 ? `${n} pages` : 'page';
  showMenu(e.clientX, e.clientY, [
    { label: `Rotate ${s} right`, kbd: 'Ctrl+R', action: () => rotatePages(list, 90) },
    { label: `Rotate ${s} left`, kbd: 'Ctrl+Shift+R', action: () => rotatePages(list, -90) },
    '-',
    { label: 'Insert blank page after', action: () => insertBlank(list[list.length - 1].uid) },
    { label: 'Insert file after…', action: async () => insertEntries(await host.pickOpen(), pageNo(list[list.length - 1])) },
    '-',
    { label: `Move ${s} to start`, action: () => movePages(list, 'start') },
    { label: `Move ${s} to end`, action: () => movePages(list, 'end') },
    { label: `Extract ${s} to PDF…`, action: () => { S.sel = new Set(list.map(p => p.uid)); updateSel(); exportSelected(); } },
    '-',
    { label: `Delete ${s}`, kbd: 'Del', danger: true, action: () => deletePages(list) },
  ]);
}
$('#bExport').onclick = e => {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, [
    { label: `Selected pages as PDF… (${S.sel.size})`, disabled: !S.sel.size, action: exportSelected },
    { label: 'One PDF per page…', disabled: !S.pages.length, action: exportSplit },
    { label: S.sel.size ? `Selected pages as PNG… (${S.sel.size})` : 'All pages as PNG…', disabled: !S.pages.length, action: exportPng },
  ], e.currentTarget);
};

// ---------------------------------------------------------------- inspector
$$('.itabs button').forEach(b => (b.onclick = () => { S.itab = b.dataset.i; renderTabs(); renderInsp(); }));
function renderTabs() { $$('.itabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.i === S.itab))); }
function sec(title, ...kids) { return h('section', { class: 'sec' }, title ? h('h3', {}, title) : null, ...kids); }
function swatchRow(cur, list, on) {
  return h('div', { class: 'swatches' }, list.map(([c, label]) => h('button', { style: `background:${c}`, 'aria-label': label, title: label, 'aria-pressed': String(cur.toLowerCase() === c.toLowerCase()), onclick: () => on(c) })));
}
const PAPER = [['A3', 297, 420], ['A4', 210, 297], ['A5', 148, 210], ['Letter', 215.9, 279.4], ['Legal', 215.9, 355.6]];
function paperName(wmm, hmm) { const [a, b] = [Math.min(wmm, hmm), Math.max(wmm, hmm)]; const m = PAPER.find(([, x, y]) => Math.abs(x - a) < 2 && Math.abs(y - b) < 2); return m ? ` (${m[0]}${wmm > hmm ? ' landscape' : ''})` : ''; }

function renderInsp() {
  const body = $('#ibody'); const top = body.scrollTop; body.replaceChildren();
  if (!S.pages.length) { body.append(sec(null, h('p', { class: 'hint' }, 'Open a PDF to see its pages, form fields and settings here.'))); return; }
  ({ page: inspPage, form: inspForm, stamps: inspStamps, doc: inspDoc })[S.itab](body);
  body.scrollTop = top;
}
function inspPage(body) {
  const { p: ip, it } = findItem();
  if (it) {
    const v = pvs.get(ip.uid);
    const redraw = () => drawItems(ip);
    const recolor = c => { commit(); it.color = c; redraw(); renderInsp(); };
    const names = { text: 'Text', rect: 'Cover box', redact: 'Redaction', img: 'Image' };
    const s = sec(names[it.type]);
    if (it.type === 'text') {
      const ta = h('textarea', { id: 'insp-text', rows: '4', placeholder: 'Type here' }); ta.value = it.text; armUndo(ta);
      ta.addEventListener('input', () => { it.text = ta.value; redraw(); updateThumb(ip); });
      const sz = h('input', { id: 'insp-size', type: 'number', min: '5', max: '96', step: '1', value: it.size }); armUndo(sz);
      sz.addEventListener('input', () => { const n = +sz.value; if (n >= 5 && n <= 96) { it.size = n; redraw(); } });
      s.append(h('label', { class: 'fld', for: 'insp-text' }, h('span', { class: 'lbl' }, 'Text'), ta),
        h('div', { class: 'fline' }, h('label', { class: 'fld', for: 'insp-size' }, h('span', { class: 'lbl' }, 'Size pt'), sz),
          h('div', { class: 'fld' }, h('span', { class: 'lbl' }, 'Color'), swatchRow(it.color, [['#111111', 'Black'], ['#1F3FBF', 'Blue'], ['#C0172F', 'Red']], recolor))));
    } else if (it.type === 'rect') {
      s.append(h('div', { class: 'fld' }, h('span', { class: 'lbl' }, 'Fill'), swatchRow(it.color, [['#000000', 'Black'], ['#FFFFFF', 'White']], recolor)),
        h('p', { class: 'hint' }, 'A cover box hides what’s under it, but the text is still in the file and can be copied out. Use Redact to remove it.'),
        h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => { commit(); it.type = 'redact'; delete it.color; redraw(); renderInsp(); } }, 'Make it a redaction')));
    } else if (it.type === 'redact') {
      s.append(h('p', { class: 'hint' }, 'When you save, everything under this box is removed from the file: text, images and form fields. A black box is left in its place. Undo can’t bring it back once saved.'));
    } else s.append(h('p', { class: 'hint' }, 'Drag to move. Drag the blue square to resize; proportions stay fixed.'));
    s.append(h('div', { class: 'btns' }, h('button', { class: 'btn danger', onclick: deleteItem }, 'Delete'), h('button', { class: 'btn quiet', onclick: () => selectItem(null, null) }, 'Done')));
    body.append(s); return;
  }
  const multi = S.sel.size > 1;
  if (multi) {
    const list = targetPages();
    body.append(sec(`${list.length} pages`,
      h('p', { class: 'hint' }, 'Selected in the sidebar. Ctrl+click adds or removes a page, Shift+click selects a range.'),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => rotatePages(list, -90) }, 'Rotate left'), h('button', { class: 'btn', onclick: () => rotatePages(list, 90) }, 'Rotate right'),
        h('button', { class: 'btn', onclick: exportSelected }, 'Extract…'), h('button', { class: 'btn danger', onclick: () => deletePages(list) }, 'Delete')),
      h('div', { class: 'btns' }, h('button', { class: 'btn quiet', onclick: () => { S.sel.clear(); updateSel(); } }, 'Clear selection'))));
  } else {
    const p = curPage(); if (!p) return; const v = vpFor(p, 1);
    const wmm = v.width / 72 * 25.4, hmm = v.height / 72 * 25.4;
    body.append(sec(`Page ${pageNo(p)}`,
      h('dl', { class: 'kv' },
        h('dt', {}, 'From'), h('dd', {}, p.doc.hidden ? 'Blank page' : `${p.doc.name}, page ${p.idx + 1}`),
        h('dt', {}, 'Size'), h('dd', {}, `${Math.round(wmm)} × ${Math.round(hmm)} mm${paperName(wmm, hmm)}`),
        h('dt', {}, 'Edits'), h('dd', {}, p.items.length ? `${p.items.length} on this page` : 'None')),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => rotatePages([p], -90) }, 'Rotate left'), h('button', { class: 'btn', onclick: () => rotatePages([p], 90) }, 'Rotate right'),
        h('button', { class: 'btn', onclick: () => insertBlank(p.uid) }, 'Blank after'), h('button', { class: 'btn danger', onclick: () => deletePages([p]) }, 'Delete'))));
  }
  const toolName = $(`#tools [data-t="${S.tool}"]`).firstChild.textContent;
  body.append(sec(toolName, h('p', { class: 'hint' }, TOOL_HINT[S.tool])));
}
function inspForm(body) {
  const docs = visDocs().filter(d => !d.hidden); const any = docs.some(d => d.fields.length);
  formSection(body, docs);
  const flat = h('input', { type: 'checkbox', id: 'f-flat', checked: S.opts.flatten });
  flat.onchange = () => { S.opts.flatten = flat.checked; markDirty(); };
  body.append(sec('Answers',
    h('p', { class: 'hint' }, 'Answers are written into the file when you save. Page previews show the original values until then.'),
    h('div', { class: 'btns' }, h('button', { class: 'btn', disabled: !any, onclick: loadAnswers }, 'Load answers…'), h('button', { class: 'btn', disabled: !any, onclick: saveAnswers }, 'Save answers…')),
    any ? h('label', { class: 'opt', for: 'f-flat' }, flat, h('div', {}, 'Flatten when saving', h('small', {}, 'Makes answers permanent page content. Combined files and redacted documents are always flattened.'))) : null));
  for (const d of docs) {
    const s = sec(null, h('div', { class: 'file' }, h('i', { style: `background:var(${d.color})` }), h('b', { class: 'nm' }, d.name), h('span', { class: 'pp' }, `${d.fields.length} fields`)));
    if (!d.fields.length) s.append(h('p', { class: 'hint' }, d.xfa ? 'XFA form with no standard fields. Use Find answer spots above, or the Text tool.' : 'No fillable fields. Use Find answer spots above, or the Text tool to type on the page.'));
    else {
      if (d.xfa) s.append(h('p', { class: 'hint' }, 'XFA (LiveCycle) form. Proof fills its standard fields and removes the XFA layer on save, so every reader shows your answers.'));
      d.fields.forEach((f, i) => {
        const cur = f.name in d.values ? d.values[f.name] : f.value; const fid = `f-${d.id}-${i}`;
        const row = h('div', { class: 'frow' + (f.name in d.values ? ' changed' : '') });
        const set = v => { d.values[f.name] = v; row.classList.add('changed'); updateChrome(); };
        let ctl;
        if (f.kind === 'check') {
          ctl = h('input', { type: 'checkbox', id: fid, disabled: f.ro }); ctl.checked = !!cur; ctl.addEventListener('change', () => set(ctl.checked));
          row.append(h('label', { class: 'chk', for: fid }, ctl, f.name));
        } else if (f.kind === 'select' || f.kind === 'radio') {
          ctl = h('select', { id: fid, disabled: f.ro }, h('option', { value: '' }, '—'), f.options.map(o => h('option', { value: o }, o))); ctl.value = cur || ''; ctl.addEventListener('change', () => set(ctl.value));
          row.append(h('label', { class: 'lbl', for: fid }, f.name), ctl);
        } else {
          ctl = f.multi ? h('textarea', { id: fid, rows: '3', disabled: f.ro }) : h('input', { type: 'text', id: fid, disabled: f.ro }); ctl.value = cur || ''; ctl.addEventListener('input', () => set(ctl.value));
          row.append(h('label', { class: 'lbl', for: fid }, f.name + (f.ro ? ' (read-only)' : '')), ctl);
        }
        armUndo(ctl); s.append(row);
      });
    }
    body.append(s);
  }
}
async function saveAnswers() {
  const fields = {}; for (const d of visDocs()) for (const f of d.fields) fields[f.name] = f.name in d.values ? d.values[f.name] : f.value;
  const base = (visDocs().find(d => d.fields.length)?.name || 'form').replace(/\.pdf$/i, '');
  const path = await host.pickSave(defaultSavePath(base + '-answers.json'), { name: 'Form answers', ext: 'json' }); if (!path) return;
  try { await host.writePath(path, new TextEncoder().encode(JSON.stringify({ proof_form_answers: 1, saved: new Date().toISOString(), fields }, null, 2))); toast(`Saved answers to ${host.baseName(path)}.`); }
  catch (e) { toast('Couldn’t save answers: ' + (e?.message || e), 6000); }
}
async function loadAnswers() {
  let entry;
  if (host.isDesktop) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({ multiple: false, filters: [{ name: 'Form answers', extensions: ['json'] }] }); if (!path) return;
    entry = { name: host.baseName(path), bytes: await host.readPath(path) };
  } else {
    entry = await new Promise(resolve => { const inp = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' }); inp.onchange = async () => { const f = inp.files[0]; resolve(f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null); }; inp.click(); });
    if (!entry) return;
  }
  let data; try { data = JSON.parse(new TextDecoder().decode(entry.bytes)); } catch { toast('That file isn’t valid JSON.'); return; }
  const src = data?.fields; if (!src || typeof src !== 'object') { toast('No answers in that file. It should come from Save answers.'); return; }
  commit(); let n = 0;
  for (const d of visDocs()) for (const f of d.fields) {
    if (!(f.name in src) || f.ro) continue; let v = src[f.name];
    if (f.kind === 'check') v = !!v; else if (f.options && !f.options.includes(v)) continue; else v = v == null ? '' : String(v);
    d.values[f.name] = v; n++;
  }
  renderInsp(); updateChrome(); toast(n ? `Filled ${n} field${n > 1 ? 's' : ''} from ${entry.name}.` : 'None of the saved field names match this form.');
}
function inspStamps(body) {
  const st = S.stamps;
  const changed = () => { redrawStamps(); updateChrome(); };
  const bind = (el, fn) => { armUndo(el); el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => { fn(el); changed(); }); return el; };
  const slotSel = (id, obj) => { const s = h('select', { id, 'aria-label': 'Position' }, SLOTS.map(([k, l]) => h('option', { value: k }, l))); s.value = obj.slot; return bind(s, el => (obj.slot = el.value)); };
  const int = (v, d, lo = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= lo ? n : d; };
  const txt = (id, obj, key, ph) => { const i = h('input', { type: 'text', id, placeholder: ph }); i.value = obj[key]; return bind(i, el => (obj[key] = el.value)); };
  const numIn = (id, obj, key, d, lo, title) => { const i = h('input', { type: 'number', id, min: String(lo), value: obj[key], title }); return bind(i, el => (obj[key] = int(el.value, d, lo))); };
  const nf = h('select', { id: 'st-n' }, [['off', 'Off'], ['n', '1'], ['nofn', '1 / 12'], ['page', 'Page 1 of 12']].map(([k, l]) => h('option', { value: k }, l))); nf.value = st.num.fmt; bind(nf, el => (st.num.fmt = el.value));
  const bOn = h('input', { type: 'checkbox', id: 'st-b', checked: st.bates.on }); bind(bOn, el => (st.bates.on = el.checked));
  const wmO = h('select', { id: 'st-wo', 'aria-label': 'Strength' }, [[0.08, 'Faint'], [0.15, 'Light'], [0.3, 'Strong']].map(([k, l]) => h('option', { value: k }, l))); wmO.value = String(st.wm.opacity); bind(wmO, el => (st.wm.opacity = +el.value));
  body.append(
    sec('Stamps', h('p', { class: 'hint' }, 'Printed on every saved page, numbered in saved order, and previewed on the pages now. Header and footer can use {page}, {pages} and {date}.')),
    sec(null, h('label', { class: 'lbl', for: 'st-h' }, 'Header'), txt('st-h', st.header, 'text', 'Confidential · {date}'), slotSel('st-hs', st.header)),
    sec(null, h('label', { class: 'lbl', for: 'st-f' }, 'Footer'), txt('st-f', st.footer, 'text', 'Case 2026-114'), slotSel('st-fs', st.footer)),
    sec(null, h('label', { class: 'lbl', for: 'st-n' }, 'Page numbers'), h('div', { class: 'fline' }, nf, h('span', { class: 'lbl' }, 'from'), numIn('st-n0', st.num, 'start', 1, 0, 'Start at')), slotSel('st-ns', st.num)),
    sec(null, h('label', { class: 'opt', for: 'st-b' }, bOn, h('div', {}, 'Bates numbers', h('small', {}, 'Prefix plus a zero-padded running number, e.g. ACME000041.'))),
      h('div', { class: 'fline' }, txt('st-bp', st.bates, 'prefix', 'Prefix')),
      h('div', { class: 'fline' }, h('span', { class: 'lbl' }, 'from'), numIn('st-b0', st.bates, 'start', 1, 0, 'Start at'), h('span', { class: 'lbl' }, 'digits'), numIn('st-bd', st.bates, 'digits', 6, 1, 'Digits')),
      slotSel('st-bs', st.bates)),
    sec(null, h('label', { class: 'lbl', for: 'st-w' }, 'Watermark'), h('div', { class: 'fline' }, txt('st-w', st.wm, 'text', 'DRAFT'), wmO)),
    sec(null, h('div', { class: 'btns' }, h('button', { class: 'btn quiet', disabled: !stampsActive(), onclick: () => { commit(); S.stamps = defaultStamps(); changed(); renderInsp(); } }, 'Clear all stamps'))));
}
function inspDoc(body) {
  const docs = visDocs().filter(d => !d.hidden);
  body.append(sec('Files', ...docs.map(d => h('div', { class: 'file', title: d.path || d.name },
    h('i', { style: `background:var(${d.color})` }), h('span', { class: 'nm' }, d.name), h('span', { class: 'pp' }, S.pages.filter(p => p.doc === d).length + ' pp'),
    d.password ? h('span', { class: 'tag' }, 'Pw') : null, d.sample ? h('span', { class: 'tag' }, 'Sample') : null,
    h('button', { class: 'x', title: 'Remove this file’s pages', 'aria-label': 'Remove ' + d.name, onclick: () => removeDoc(d) }, '×'))),
    h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: async () => insertEntries(await host.pickOpen()) }, 'Insert file…'))));
  const rev = h('input', { type: 'checkbox', id: 'd-rev', checked: true });
  const scope = S.sel.size >= 2 ? `the ${S.sel.size} selected pages` : `all ${S.pages.length} pages`;
  body.append(sec('Arrange',
    h('p', { class: 'hint' }, `Applies to ${scope}.`),
    h('div', { class: 'btns' }, h('button', { class: 'btn', disabled: S.pages.length < 2, onclick: reversePages }, 'Reverse order')),
    h('p', { class: 'hint' }, 'Collate scan: for a double-sided document scanned one side at a time, all fronts then all backs. Weaves them back into 1, 2, 3, 4…'),
    h('label', { class: 'opt', for: 'd-rev' }, rev, h('div', {}, 'Backs are in reverse order', h('small', {}, 'The usual case: you flipped the stack.'))),
    h('div', { class: 'btns' }, h('button', { class: 'btn', disabled: S.pages.length < 2, onclick: () => collatePages(rev.checked) }, 'Collate scan'))));
  const strip = h('input', { type: 'checkbox', id: 'd-strip', checked: S.opts.strip }); strip.onchange = () => { S.opts.strip = strip.checked; markDirty(); };
  const comp = h('input', { type: 'checkbox', id: 'd-comp', checked: S.opts.compress }); comp.onchange = () => { S.opts.compress = comp.checked; markDirty(); };
  const pw = h('input', { type: 'password', id: 'd-pw', autocomplete: 'new-password', placeholder: 'No password' }); pw.value = S.opts.password;
  const show = h('input', { type: 'checkbox', id: 'd-show' }); show.onchange = () => (pw.type = show.checked ? 'text' : 'password');
  const msg = h('p', { class: 'msg', role: 'alert' });
  pw.addEventListener('input', () => {
    if (pw.value.includes(',')) { msg.textContent = 'Passwords can’t contain commas.'; return; }
    msg.textContent = ''; S.opts.password = pw.value; markDirty();
  });
  body.append(sec('When saving',
    h('label', { class: 'opt', for: 'd-strip' }, strip, h('div', {}, 'Strip metadata', h('small', {}, 'Removes author, title, creator software, dates and the XMP block.'))),
    h('label', { class: 'opt', for: 'd-comp' }, comp, h('div', {}, 'Compress', h('small', {}, 'Removes unused objects and duplicates, and compresses everything. Images keep their quality.'))),
    h('label', { class: 'fld', for: 'd-pw' }, h('span', { class: 'lbl' }, 'Password to open'), pw),
    h('label', { class: 'opt', for: 'd-show' }, show, h('div', {}, 'Show password')), msg,
    h('p', { class: 'hint' }, 'AES-256. Anyone opening the saved file will need this password. Leave empty for none.')));
}

// ---------------------------------------------------------------- signature
function trimCanvas(cv) {
  const ctx = cv.getContext('2d'); const d = ctx.getImageData(0, 0, cv.width, cv.height).data; let x0 = cv.width, y0 = cv.height, x1 = -1, y1 = -1;
  for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) if (d[(y * cv.width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const pad = 8; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(cv.width, x1 + pad); y1 = Math.min(cv.height, y1 + pad);
  const out = document.createElement('canvas'); out.width = x1 - x0; out.height = y1 - y0;
  out.getContext('2d').drawImage(cv, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return { url: out.toDataURL('image/png'), aspect: out.width / out.height };
}
function openSign() {
  const INK = '#10204F', FONT = '"Mrs Saint Delafield", "Segoe Script", cursive';
  let saved = lsGet(SIG_KEY), mode = saved ? 'saved' : 'draw', inked = false, drawing = false, last = null;
  const tabs = h('div', { class: 'seg' });
  const pSaved = h('div', { class: 'fld' }), pDraw = h('div', { class: 'fld' }), pType = h('div', { class: 'fld' });
  const cv = h('canvas', { class: 'sig' }), typed = h('input', { type: 'text', id: 'sig-type', placeholder: 'Your name' }), tprev = h('canvas', { class: 'sig', style: 'height:110px' });
  const remember = h('input', { type: 'checkbox', id: 'sig-rem', checked: true });
  const remLine = h('label', { class: 'opt', for: 'sig-rem' }, remember, h('div', {}, 'Remember for next time', h('small', {}, 'Stored on this computer only. Replaces any saved signature.')));
  pDraw.append(h('span', { class: 'lbl' }, 'Draw with your mouse, pen or finger'), cv, h('div', {}, h('button', { class: 'btn quiet', onclick: () => { cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); inked = false; } }, 'Clear')));
  pType.append(h('label', { class: 'lbl', for: 'sig-type' }, 'Type your name'), typed, tprev);
  const m = modal('Sign', tabs, pSaved, pDraw, pType, remLine,
    h('div', { class: 'actions' }, h('button', { class: 'btn quiet', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: done }, 'Place signature')));
  function renderSaved() {
    pSaved.replaceChildren();
    if (saved) pSaved.append(h('span', { class: 'lbl' }, 'Saved signature'), h('div', { class: 'sigprev' }, h('img', { src: saved, alt: 'Saved signature' })),
      h('div', {}, h('button', { class: 'btn danger', onclick: () => { lsSet(SIG_KEY, null); saved = null; setMode('draw'); toast('Saved signature removed.'); } }, 'Forget it')));
  }
  function setMode(md) {
    mode = md;
    tabs.replaceChildren(...[saved ? ['saved', 'Saved'] : null, ['draw', 'Draw'], ['type', 'Type']].filter(Boolean).map(([k, l]) => h('button', { 'aria-pressed': String(k === mode), onclick: () => setMode(k) }, l)));
    pSaved.hidden = mode !== 'saved'; pDraw.hidden = mode !== 'draw'; pType.hidden = mode !== 'type'; remLine.hidden = mode === 'saved';
    if (mode === 'draw') sizeCv(cv, true);
    if (mode === 'type') { sizeCv(tprev); drawTyped(); typed.focus(); }
    renderSaved();
  }
  function sizeCv(c, ink) {
    const r = c.getBoundingClientRect(); if (!r.width || c._sized) return;
    c.width = r.width * 2; c.height = r.height * 2; c._sized = 1; const x = c.getContext('2d'); x.scale(2, 2);
    if (ink) { x.lineWidth = 2.4; x.lineCap = 'round'; x.lineJoin = 'round'; x.strokeStyle = INK; }
  }
  const pt = e => { const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  cv.addEventListener('pointerdown', e => { drawing = true; last = pt(e); cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', e => { if (!drawing) return; const p = pt(e), x = cv.getContext('2d'); x.beginPath(); x.moveTo(...last); x.lineTo(...p); x.stroke(); last = p; inked = true; });
  cv.addEventListener('pointerup', () => (drawing = false));
  async function drawTyped() {
    try { await document.fonts.load(`60px ${FONT}`, typed.value || 'Sign'); } catch {}
    const x = tprev.getContext('2d'), w = tprev.width / 2, ht = tprev.height / 2; x.clearRect(0, 0, w, ht);
    x.fillStyle = INK; x.textBaseline = 'middle'; let size = 60; x.font = `${size}px ${FONT}`;
    const tw = x.measureText(typed.value).width; if (tw > w - 32) { size = (size * (w - 32)) / tw; x.font = `${size}px ${FONT}`; }
    x.fillText(typed.value, 16, ht / 2);
  }
  typed.addEventListener('input', drawTyped);
  typed.addEventListener('keydown', e => { if (e.key === 'Enter') done(); });
  async function done() {
    let res = null;
    if (mode === 'saved') { const img = new Image(); img.src = saved; await img.decode().catch(() => {}); res = { url: saved, aspect: img.width / img.height || 3 }; }
    else if (mode === 'draw') res = inked ? trimCanvas(cv) : null;
    else if (typed.value.trim()) {
      try { await document.fonts.load(`120px ${FONT}`, typed.value); } catch {}
      const c = document.createElement('canvas'), x = c.getContext('2d'); x.font = `120px ${FONT}`;
      c.width = Math.ceil(x.measureText(typed.value).width + 80); c.height = 220;
      x.font = `120px ${FONT}`; x.fillStyle = INK; x.textBaseline = 'middle'; x.fillText(typed.value, 40, 110); res = trimCanvas(c);
    }
    if (!res) { toast(mode === 'type' ? 'Type your name first.' : 'Draw your signature first.'); return; }
    if (mode !== 'saved' && remember.checked && !lsSet(SIG_KEY, res.url)) toast('Couldn’t remember the signature on this computer.');
    m.close(); placeCentered(res.url, res.aspect);
  }
  setMode(mode);
}

// ---------------------------------------------------------------- empty state
function renderEmpty() {
  const recent = host.isDesktop ? host.recentFiles() : [];
  $('#empty').replaceChildren(h('div', { class: 'box' },
    h('h1', { class: 'mark' }, 'Proof'),
    h('p', {}, 'Combine, reorder and rotate pages. Type, sign and stamp on them, fill forms, redact for real, number and password-protect. Everything stays on this computer.'),
    h('div', { class: 'acts' },
      h('button', { class: 'btn primary', onclick: doOpen }, 'Open a PDF'),
      h('button', { class: 'btn', onclick: openSample }, 'Try the sample')),
    h('p', { class: 'lbl' }, 'Or drop PDFs and images anywhere in this window. Word and Excel forms open straight into Fill from profile.'),
    recent.length ? h('div', { class: 'fld' }, h('span', { class: 'lbl' }, 'Recent'),
      h('div', { class: 'recent' }, recent.map(p => h('button', { title: p, onclick: () => openPaths([p], 'open') }, h('b', {}, host.baseName(p)), h('span', {}, host.dirName(p)))))) : null));
}
async function openSample() { await openEntries([{ name: 'Sample rental application.pdf', path: null, type: 'application/pdf', bytes: await samplePdf(), sample: true }]); S.dirty = false; updateChrome(); }

// ---------------------------------------------------------------- chrome
function updateChrome() {
  const n = S.pages.length, c = curPage();
  $('#stPage').textContent = n ? `Page ${c ? pageNo(c) : 1} of ${n}` : 'No document';
  const files = visDocs().filter(d => !d.hidden).length, ed = editCount();
  $('#stInfo').textContent = n ? [`${files} file${files === 1 ? '' : 's'}`, ed ? `${ed} edit${ed === 1 ? '' : 's'}` : null, S.sel.size > 1 ? `${S.sel.size} selected` : null, stampsActive() ? 'Stamps on' : null, S.opts.password ? 'Password on save' : null].filter(Boolean).join(' · ') : '';
  const st = $('#stState'); st.textContent = n ? (S.dirty ? 'Unsaved changes' : 'Saved') : ''; st.className = S.dirty ? 'dirty' : '';
  $('#stPath').textContent = n ? (S.path || 'Not saved yet') : '';
  $('#bUndo').disabled = !S.undo.length; $('#bRedo').disabled = !S.redo.length;
  for (const id of ['#bSave', '#bSaveAs', '#bExport', '#bInsert']) $(id).disabled = !n;
  $$('#tools button').forEach(b => (b.disabled = !n));
  $('#cFields').textContent = visDocs().reduce((a, d) => a + d.fields.length, 0) || '';
  $('#cStamps').textContent = stampsActive() ? '●' : '';
  host.setTitle(n ? `${S.dirty ? '● ' : ''}${S.title || 'Untitled'} — Proof` : 'Proof');
}
function renderAll() { renderThumbs(); layoutView(); renderTabs(); renderInsp(); updateChrome(); }

// ---------------------------------------------------------------- commands & keys
async function doOpen() { const e = await host.pickOpen(); if (e.length) openEntries(e); }
async function doInsert() { if (!S.pages.length) return doOpen(); const e = await host.pickOpen(); if (e.length) insertEntries(e); }
$('#bOpen').onclick = doOpen; $('#bInsert').onclick = doInsert;
$('#bSave').onclick = () => save(false); $('#bSaveAs').onclick = () => save(true);
$('#bUndo').onclick = undo; $('#bRedo').onclick = redo;
$('#bProfile').onclick = () => openProfile();

/** Type answers onto pages of a document (flat forms). y is the baseline of the first line. Caller commits. */
function placeText(doc, items) {
  const touched = new Set();
  for (const it of items) {
    const p = S.pages.find(p => p.doc === doc && p.idx === it.page); if (!p) continue;
    const n = it.text.split('\n').length;
    p.items.push({ type: 'text', id: uid(), x: it.x, y: it.y - (1.2 * n - 0.95) * it.size, text: it.text, size: it.size, color: '#111111', theta: (p.doc.proxies[p.idx].rotate + p.rot) % 360 });
    touched.add(p);
  }
  for (const p of touched) { drawItems(p); updateThumb(p); }
}
initKyc({ S, h, sec, modal, toast, busy, commit: () => commit(), renderInsp, updateChrome, insertEntries, openEntries, placeText });

document.addEventListener('keydown', e => {
  // Keep webview browser shortcuts (reload, print the app UI, find bar) from firing in a desktop app.
  if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && ['p', 'f', 'g', 'u', 'j'].includes(e.key.toLowerCase()))) { e.preventDefault(); return; }
  if ($('.scrim') || $('.busy') || $('.kyc')) return;
  if (menuEl && e.key === 'Escape') { closeMenu(); return; }
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod) {
    if (k === 'o') { e.preventDefault(); doOpen(); return; }
    if (k === 'i') { e.preventDefault(); doInsert(); return; }
    if (k === 's') { e.preventDefault(); save(e.shiftKey); return; }
    if (k === '=' || k === '+') { e.preventDefault(); zoomStep(1); return; }
    if (k === '-') { e.preventDefault(); zoomStep(-1); return; }
    if (k === '0') { e.preventDefault(); setZoom('fit'); return; }
    if (k === '1') { e.preventDefault(); setZoom(1); return; }
    if (typing()) return;
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); return; }
    if (k === 'a') { e.preventDefault(); S.pages.forEach(p => S.sel.add(p.uid)); updateSel(); return; }
    if (k === 'r') { e.preventDefault(); rotatePages(targetPages(), e.shiftKey ? -90 : 90); return; }
    return;
  }
  if (typing()) return;
  if (e.key === 'Escape') { if (S.selItem) selectItem(null, null); else if (S.tool !== 'select') setTool('select'); else if (S.sel.size) { S.sel.clear(); updateSel(); } return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    if (S.selItem) deleteItem(); else if (S.sel.size) deletePages(targetPages());
    return;
  }
  if (S.selItem && e.key.startsWith('Arrow')) {
    e.preventDefault(); const d = e.shiftKey ? 10 : 1;
    nudge(e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0); return;
  }
  const tool = { v: 'select', t: 'text', d: 'date', c: 'cover', r: 'redact', i: 'image', s: 'sign' }[k];
  if (tool && S.pages.length) { e.preventDefault(); useTool(tool); return; }
  if ((e.key === 'PageDown' || e.key === 'PageUp') && S.pages.length) {
    e.preventDefault(); const i = pageNo(curPage()) - 1 + (e.key === 'PageDown' ? 1 : -1);
    const p = S.pages[Math.max(0, Math.min(S.pages.length - 1, i))]; setCur(p.uid, true);
  }
});

// ---------------------------------------------------------------- startup
let dropEl = null;
host.onDrop(entries => { if (!entries.length) return; S.pages.length ? insertEntries(entries) : openEntries(entries); },
  on => { if (on && !dropEl) { dropEl = h('div', { class: 'dropover' }, h('span', {}, S.pages.length ? 'Drop to insert' : 'Drop to open')); document.body.append(dropEl); } else if (!on) { dropEl?.remove(); dropEl = null; } });
const closeHandler = async () => {
  if (!S.dirty) return true;
  const r = await askUnsaved('closing');
  if (r === 'cancel') return false;
  if (r === 'save') return save();
  return true;
};
closeHandler.dirty = () => S.dirty;
host.onCloseRequested(closeHandler);
host.onOpenFiles(paths => openPaths(paths, 'ask'));

renderAll();
const launch = await host.launchFiles();
if (launch.length) openPaths(launch, 'open');
if (!host.isDesktop) window.__proof = { S, openEntries, insertEntries, samplePdf, produce };

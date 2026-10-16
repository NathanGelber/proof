// PDF engines.
// pdf.js renders pages. pdf-lib reads forms and assembles the output (page order, rotation,
// text, images, stamps, form answers). MuPDF unlocks protected files and does the final pass:
// true redaction, compression, encryption.

import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, PDFName, StandardFonts, rgb, degrees, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList, PDFSignature } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { systemFont } from './host.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
export { pdfjsLib };

let muP = null;
export const mupdf = () => (muP ||= import('mupdf'));
export class Cancelled extends Error {}

const take = buf => { const a = buf.asUint8Array().slice(); buf.destroy?.(); return a; };

/** Convert an image file to a one-page PDF. */
export async function imageToPdf(bytes, type) {
  const doc = await PDFDocument.create();
  const img = /png/i.test(type) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  let w = img.width * 0.75, h = img.height * 0.75; const k = Math.min(1, 842 / Math.max(w, h)); w *= k; h *= k;
  doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  return doc.save();
}

/**
 * Make bytes usable by pdf.js and pdf-lib: asks for a password when needed, removes encryption,
 * and repairs files pdf-lib can't parse. Returns { bytes, password, unlocked, repaired }.
 */
export async function prepare(bytes, askPassword) {
  const mu = await mupdf();
  let doc;
  try { doc = mu.Document.openDocument(bytes, 'application/pdf'); }
  catch { throw new Error('This doesn’t look like a readable PDF.'); }
  try {
    let password = null;
    if (doc.needsPassword()) {
      for (let attempt = 0; ; attempt++) {
        const pw = await askPassword(attempt);
        if (pw == null) throw new Cancelled();
        if (doc.authenticatePassword(pw)) { password = pw; break; }
      }
    }
    const enc = doc.getMetaData('encryption') || 'None';
    let unlocked = false, repaired = false;
    if (enc !== 'None') { bytes = take(doc.saveToBuffer('encrypt=none')); unlocked = true; }
    try { await PDFDocument.load(bytes, { updateMetadata: false }); }
    catch {
      bytes = take(doc.saveToBuffer('encrypt=none,garbage=compact'));
      repaired = true;
      await PDFDocument.load(bytes, { updateMetadata: false }); // throws if still unreadable
    }
    return { bytes, password, unlocked, repaired };
  } finally { doc.destroy?.(); }
}

/** Page index of a widget annotation, or -1. */
function widgetPager(ld) {
  const pages = ld.getPages();
  const refIdx = new Map(pages.map((p, i) => [p.ref.toString(), i]));
  const annotIdx = new Map();
  pages.forEach((p, i) => { try { for (const r of p.node.Annots()?.asArray() || []) annotIdx.set(r.toString(), i); } catch {} });
  return w => {
    let pi = -1;
    try { const P = w.P(); if (P) pi = refIdx.get(P.toString()) ?? -1; } catch {}
    if (pi < 0) { const r = ld.context.getObjectRef(w.dict); if (r) pi = annotIdx.get(r.toString()) ?? -1; }
    return pi;
  };
}

export function readFields(ld) {
  const out = [];
  let form; try { form = ld.getForm(); } catch { return { fields: out, xfa: false }; }
  const pageOf = widgetPager(ld);
  const widgets = f => { try { return f.acroField.getWidgets().map(w => { const r = w.getRectangle(); return { page: pageOf(w), rect: [r.x, r.y, r.width, r.height] }; }).filter(w => w.page >= 0); } catch { return []; } };
  let xfa = false; try { xfa = form.hasXFA(); } catch {}
  let fs = []; try { fs = form.getFields(); } catch {}
  let signed = false;
  for (const f of fs) {
    // A signature field with a value: the file carries a digital signature that any rewrite invalidates.
    if (f instanceof PDFSignature) { try { if (f.acroField.dict.get(PDFName.of('V'))) signed = true; } catch {} continue; }
    const name = f.getName(); let ro = false; try { ro = f.isReadOnly(); } catch {}
    try {
      if (f instanceof PDFTextField) out.push({ name, kind: 'text', value: f.getText() || '', multi: f.isMultiline(), ro });
      else if (f instanceof PDFCheckBox) out.push({ name, kind: 'check', value: f.isChecked(), ro });
      else if (f instanceof PDFDropdown) out.push({ name, kind: 'select', options: f.getOptions(), value: f.getSelected()[0] || '', ro });
      else if (f instanceof PDFRadioGroup) out.push({ name, kind: 'radio', options: f.getOptions(), value: f.getSelected() || '', ro });
      else if (f instanceof PDFOptionList) out.push({ name, kind: 'select', options: f.getOptions(), value: f.getSelected()[0] || '', ro });
    } catch {}
    if (out.length && out[out.length - 1].name === name) { out[out.length - 1].widgets = widgets(f); try { out[out.length - 1].maxLen = f instanceof PDFTextField ? f.getMaxLength() || 0 : 0; } catch {} }
  }
  return { fields: out, xfa, signed };
}

export async function inspect(bytes) {
  const ld = await PDFDocument.load(bytes, { updateMetadata: false });
  const { fields, xfa, signed } = readFields(ld);
  let title = ''; try { title = ld.getTitle() || ''; } catch {}
  return { fields, xfa, signed, title };
}

function applyForm(ld, values, xfa, errs) {
  let form; try { form = ld.getForm(); } catch { return; }
  for (const [name, v] of Object.entries(values)) {
    try {
      const f = form.getField(name);
      if (f instanceof PDFTextField) f.setText(v || undefined);
      else if (f instanceof PDFCheckBox) v ? f.check() : f.uncheck();
      else if (f instanceof PDFDropdown || f instanceof PDFOptionList || f instanceof PDFRadioGroup) v ? f.select(v) : f.clear();
    } catch (e) { errs.push(`Field “${name}”: ${e.message}`); }
  }
  try { if (xfa) form.deleteXFA(); } catch {}
}

const hexRgb = c => { const n = parseInt(c.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
function vis2user(R, b, u, v) {
  switch (R) {
    case 90: return [b.x + b.width - v, b.y + u];
    case 180: return [b.x + b.width - u, b.y + b.height - v];
    case 270: return [b.x + v, b.y + b.height - u];
    default: return [b.x + u, b.y + v];
  }
}
function stripMeta(doc) {
  try { const t = doc.context.trailerInfo; if (t.Info) { doc.context.delete(t.Info); t.Info = undefined; } doc.catalog.delete(PDFName.of('Metadata')); } catch {}
}
/** Axis-aligned user-space rectangle of a box item rotated by theta about its bottom-left corner. */
export function itemUserRect(it) {
  const th = (it.theta * Math.PI) / 180, c = Math.round(Math.cos(th)), s = Math.round(Math.sin(th));
  const pts = [[0, 0], [it.w, 0], [0, it.h], [it.w, it.h]].map(([dx, dy]) => [it.x + dx * c - dy * s, it.y + dx * s + dy * c]);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Assemble the output with pdf-lib.
 * pages: [{doc, idx, rot, items}], doc: {bytes, values, xfa, fields}
 * stamps: function(k, N, W, H, measure) -> {lines, wm}, or null
 * Returns { bytes, errs, redactions: [{k, rects}] } — redactions are applied by finalize().
 * Prefer compose(), which runs the whole pipeline in the right order.
 */
export async function build(pages, { flatten, strip, stamps, overlays = true }, prog) {
  const docs = [...new Set(pages.map(p => p.doc))]; const multi = docs.length > 1; const errs = [];
  const srcs = new Map();
  for (const d of docs) {
    const ld = await PDFDocument.load(d.bytes, { updateMetadata: false });
    applyForm(ld, d.values, d.xfa, errs);
    if (d.fields.length && (flatten || multi)) {
      try { ld.getForm().updateFieldAppearances(); ld.getForm().flatten(); } catch (e) { errs.push(`Flattening ${d.name}: ${e.message}`); }
    }
    srcs.set(d, ld);
  }
  let out, outPages;
  if (!multi) {
    out = srcs.get(docs[0]); const all = out.getPages();
    for (let i = all.length - 1; i >= 0; i--) out.removePage(i);
    pages.forEach((p, k) => out.insertPage(k, all[p.idx]));
    outPages = out.getPages();
  } else {
    out = await PDFDocument.create({ updateMetadata: !strip }); const map = new Map();
    for (const d of docs) {
      const idxs = [...new Set(pages.filter(p => p.doc === d).map(p => p.idx))];
      const cp = await out.copyPages(srcs.get(d), idxs); idxs.forEach((ix, k) => map.set(d.id + ':' + ix, cp[k]));
    }
    outPages = pages.map(p => out.addPage(map.get(p.doc.id + ':' + p.idx)));
  }

  const N = pages.length, redactions = [];
  for (let k = 0; k < N; k++) {
    const p = pages[k];
    if (p.rot) outPages[k].setRotation(degrees((outPages[k].getRotation().angle + p.rot) % 360));
    const rects = p.items.filter(i => i.type === 'redact').map(itemUserRect);
    if (rects.length) redactions.push({ k, rects });
  }
  // Without redactions, draw overlays now. With them, the caller redacts first and then calls overlay(),
  // so text, signatures and stamps placed over a redaction survive it.
  if (overlays) await drawOverlays(out, outPages, pages, stamps, errs, prog);
  if (strip) stripMeta(out);
  return { bytes: await saveDoc(out), errs, redactions };
}

const encErr = m => /WinAnsi|cannot encode/i.test(m);
async function saveDoc(out) {
  try { return await out.save(); }
  catch (e) { throw new Error(encErr(e.message) ? 'A form answer uses characters the form’s font can’t encode. Remove them and save again.' : e.message); }
}

/** Draw added text, boxes, images and stamps onto an already assembled PDF (same page order). */
export async function overlay(bytes, pages, { stamps, strip }, prog) {
  const out = await PDFDocument.load(bytes, { updateMetadata: false }); const errs = [];
  await drawOverlays(out, out.getPages(), pages, stamps, errs, prog);
  if (strip) stripMeta(out);
  return { bytes: await saveDoc(out), errs };
}

async function drawOverlays(out, outPages, pages, stamps, errs, prog) {
  let font = null;
  const sys = await systemFont();
  const getFont = async () => {
    if (font) return font;
    if (sys) { try { out.registerFontkit(fontkit); font = await out.embedFont(sys, { subset: true }); return font; } catch {} }
    return (font = await out.embedFont(StandardFonts.Helvetica));
  };
  const imgs = new Map(); const N = pages.length;
  for (let k = 0; k < N; k++) {
    prog?.(`Page ${k + 1} of ${N}`);
    const p = pages[k], pg = outPages[k];
    for (const it of p.items) {
      const th = (it.theta * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
      try {
        if (it.type === 'text') {
          if (!it.text.trim()) continue;
          const f = await getFont(), n = it.text.split('\n').length, ly = n * it.size * 1.2 - 0.95 * it.size;
          pg.drawText(it.text, { x: it.x - ly * s, y: it.y + ly * c, size: it.size, font: f, color: hexRgb(it.color), lineHeight: it.size * 1.2, rotate: degrees(it.theta) });
        } else if (it.type === 'rect') {
          pg.drawRectangle({ x: it.x, y: it.y, width: it.w, height: it.h, color: hexRgb(it.color), rotate: degrees(it.theta), borderWidth: 0 });
        } else if (it.type === 'img') {
          let im = imgs.get(it.src);
          if (!im) { const raw = Uint8Array.from(atob(it.src.split(',')[1]), ch => ch.charCodeAt(0)); im = it.src.startsWith('data:image/png') ? await out.embedPng(raw) : await out.embedJpg(raw); imgs.set(it.src, im); }
          pg.drawImage(im, { x: it.x, y: it.y, width: it.w, height: it.h, rotate: degrees(it.theta) });
        }
      } catch (e) { errs.push(encErr(e.message) ? `Page ${k + 1}: some text uses characters the font can’t encode and was skipped.` : `Page ${k + 1}: ${e.message}`); }
    }
    if (stamps) {
      try {
        const f = await getFont(); const R = ((pg.getRotation().angle % 360) + 360) % 360; const b = pg.getCropBox();
        const W = R % 180 ? b.height : b.width, H = R % 180 ? b.width : b.height;
        const { lines, wm } = stamps(k, N, W, H, (t, sz) => f.widthOfTextAtSize(t, sz));
        if (wm) {
          const a = Math.PI / 4, ca = Math.cos(a), sa = Math.sin(a);
          const [x, y] = vis2user(R, b, W / 2 - wm.w / 2 * ca + 0.35 * wm.size * sa, H / 2 - wm.w / 2 * sa - 0.35 * wm.size * ca);
          pg.drawText(wm.text, { x, y, size: wm.size, font: f, color: rgb(0.5, 0.5, 0.5), opacity: wm.opacity, rotate: degrees(R + 45) });
        }
        for (const l of lines) { const [x, y] = vis2user(R, b, l.u, l.v); pg.drawText(l.text, { x, y, size: l.size, font: f, color: rgb(0, 0, 0), rotate: degrees(R) }); }
      } catch (e) { errs.push(encErr(e.message) ? 'Stamp text uses characters the font can’t encode, so stamps were skipped on some pages.' : `Stamps on page ${k + 1}: ${e.message}`); }
    }
  }
}

/** Full pipeline: assemble → (redact → overlay) → compress / encrypt / strip. */
export async function compose(pages, { flatten, strip, stamps, compress, password }, prog) {
  const hasRed = pages.some(p => p.items.some(i => i.type === 'redact'));
  // A redacted file never keeps its metadata: title, subject, keywords and XMP can repeat what was blacked out.
  if (hasRed) strip = true;
  let { bytes, errs, redactions } = await build(pages, { flatten: flatten || hasRed, strip, stamps, overlays: !hasRed }, prog);
  if (redactions.length) {
    prog?.('Redacting…');
    const notes = [];
    bytes = await finalize(bytes, { redactions, compress: false, strip: true, notes });
    const o = await overlay(bytes, pages, { stamps, strip }, prog); bytes = o.bytes; errs = errs.concat(notes, o.errs);
  }
  prog?.('Finishing…');
  return { bytes: await finalize(bytes, { compress, password, strip }), errs };
}

/** MuPDF splits its save options on commas, so a comma in a password would cut it short or add an option. */
export function checkPassword(pw) {
  if (pw && pw.includes(',')) throw new Error('Passwords can’t contain commas. Change it under Document.');
}

const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/**
 * MuPDF pass: true redaction, cleanup/compression, encryption, metadata removal.
 * Always rewrites the file and drops unreferenced objects, so deleted pages, unlinked metadata
 * and earlier revisions never survive in what's saved. notes: optional array for warnings.
 */
export async function finalize(bytes, { redactions = [], compress = true, password = '', strip = true, notes = null }) {
  checkPassword(password);
  const mu = await mupdf();
  const doc = mu.Document.openDocument(bytes, 'application/pdf');
  try {
    for (const { k, rects } of redactions) {
      const pg = doc.loadPage(k); const m = pg.getTransform();
      const tp = (x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
      const boxes = rects.map(([x0, y0, x1, y1]) => {
        const a = tp(x0, y0), b = tp(x1, y1);
        return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      });
      // Comments, notes, links and other annotations under a box go with it: applyRedactions leaves
      // some of them (sticky notes) in place with their text. Form fields were flattened before this.
      for (const an of pg.getAnnotations()) {
        if (an.getType() === 'Redact') continue;
        if (boxes.some(bx => overlaps(an.getRect(), bx))) pg.deleteAnnotation(an);
      }
      for (const bx of boxes) pg.createAnnotation('Redact').setRect(bx);
      pg.applyRedactions(true, 2);
    }
    if (redactions.length && notes) {
      let outline = []; try { outline = doc.loadOutline() || []; } catch {}
      if (outline.length) notes.push('This file has bookmarks. Their titles aren’t redacted; check they don’t name what you blacked out.');
    }
    if (strip) {
      try { doc.getTrailer().delete('Info'); } catch {}
      try { doc.getTrailer().get('Root').delete('Metadata'); } catch {}
    }
    const opts = [compress ? 'garbage=deduplicate' : 'garbage=compact'];
    if (compress) opts.push('compress');
    if (password) {
      const owner = Array.from(crypto.getRandomValues(new Uint8Array(18)), b => b.toString(16).padStart(2, '0')).join('');
      opts.push('encrypt=aes-256', `user-password=${password}`, `owner-password=${owner}`);
    }
    return take(doc.saveToBuffer(opts.join(',')));
  } finally { doc.destroy?.(); }
}

/** Render pages of a PDF to PNG bytes with MuPDF. dpi default 150. */
export async function renderPngs(bytes, dpi = 150, onPage) {
  const mu = await mupdf();
  const doc = mu.Document.openDocument(bytes, 'application/pdf'); const out = [];
  try {
    const n = doc.countPages();
    for (let i = 0; i < n; i++) {
      onPage?.(i, n);
      const pg = doc.loadPage(i);
      const pix = pg.toPixmap(mu.Matrix.scale(dpi / 72, dpi / 72), mu.ColorSpace.DeviceRGB, false, true);
      out.push(pix.asPNG().slice()); pix.destroy?.(); pg.destroy?.();
    }
  } finally { doc.destroy?.(); }
  return out;
}

/** Pages of a finished PDF as PNGs for printing, with each page's size in points (rotation applied). */
export async function renderForPrint(bytes, dpi, onPage) {
  const mu = await mupdf();
  const doc = mu.Document.openDocument(bytes, 'application/pdf'); const out = [];
  try {
    const n = doc.countPages();
    for (let i = 0; i < n; i++) {
      onPage?.(i, n);
      const pg = doc.loadPage(i); const [x0, y0, x1, y1] = pg.getBounds();
      const w = x1 - x0, h = y1 - y0;
      const sc = Math.min(dpi / 72, Math.sqrt(60e6 / Math.max(1, w * h))); // keep huge pages under ~60 megapixels
      const pix = pg.toPixmap(mu.Matrix.scale(sc, sc), mu.ColorSpace.DeviceRGB, false, true);
      out.push({ png: pix.asPNG().slice(), w, h }); pix.destroy?.(); pg.destroy?.();
    }
  } finally { doc.destroy?.(); }
  return out;
}

/** Split a finished PDF into single-page PDFs. */
export async function splitPages(bytes) {
  const src = await PDFDocument.load(bytes, { updateMetadata: false }); const out = [];
  for (let i = 0; i < src.getPageCount(); i++) {
    const one = await PDFDocument.create({ updateMetadata: false }); const [cp] = await one.copyPages(src, [i]); one.addPage(cp);
    out.push(await one.save());
  }
  return out;
}

export async function blankPdf(w, h) { const d = await PDFDocument.create(); d.addPage([w, h]); return d.save(); }

// Reading a counterparty form: its fields with the text printed around them, or for a flat
// form its text lines with positions. Nothing here knows about the profile.

import { PDFDocument, PDFName, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList } from 'pdf-lib';

export const fold = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const norm = s => fold(s).replace(/[^a-z0-9%]+/g, ' ').trim();
const clean = s => (s || '').replace(/\s+/g, ' ').trim();

/** A readable version of an internal field name: "form1[0].p1[0].CompanyName_2[0]" → "Company Name 2". */
export function niceName(n) {
  const last = (n || '').split('.').pop().replace(/\[\d+\]/g, '');
  return clean(last.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/[_\-]+/g, ' '));
}

/** Text lines of each page, in reading order: [{id, page, y, x0, x1, size, text, segs:[{x0,x1,str}]}]. Coordinates are PDF user space. */
export async function pageLines(doc) {
  const out = [];
  for (let pi = 0; pi < doc.proxies.length; pi++) {
    let tc; try { tc = await doc.proxies[pi].getTextContent(); } catch { continue; }
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim() || !it.transform) continue;
      const [a, b, c, d, e, f] = it.transform;
      if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a < 0) continue; // skip rotated text
      const size = Math.abs(d) || Math.abs(a) || 10;
      items.push({ x0: e, x1: e + (it.width || it.str.length * size * 0.5), y: f, size, str: it.str });
    }
    items.sort((p, q) => q.y - p.y || p.x0 - q.x0);
    const lines = [];
    for (const it of items) {
      const ln = lines.find(l => Math.abs(l.y - it.y) < Math.min(l.size, it.size) * 0.45);
      if (ln) { ln.segs.push(it); ln.size = Math.max(ln.size, it.size); } else lines.push({ y: it.y, size: it.size, segs: [it] });
    }
    lines.sort((p, q) => q.y - p.y);
    lines.forEach((l, i) => {
      l.segs.sort((p, q) => p.x0 - q.x0);
      // Merge touching segments so "Name" "of" "company" become one label.
      const segs = [];
      for (const s of l.segs) {
        const prev = segs[segs.length - 1];
        if (prev && s.x0 - prev.x1 < s.size * 0.6) { prev.str += (s.x0 - prev.x1 > s.size * 0.15 && !/\s$/.test(prev.str) ? ' ' : '') + s.str; prev.x1 = Math.max(prev.x1, s.x1); }
        else segs.push({ ...s });
      }
      const text = clean(segs.map(s => s.str).join('  '));
      out.push({ id: `L${pi + 1}-${i + 1}`, page: pi + 1, y: l.y, size: l.size, x0: segs[0].x0, x1: segs[segs.length - 1].x1, segs, text });
    });
  }
  return out;
}

const HEADING_RE = /^((\d+(\.\d+)*|[A-H]|[IVX]+)[.)]?\s+\S|(section|part|deel|onderdeel|schedule|annex|appendix|bijlage)\b)/i;
export function isHeading(l, medianSize) {
  const t = l.text; if (t.length < 3 || t.length > 80) return false;
  const letters = t.replace(/[^A-Za-z]/g, ''); if (letters.length < 3) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length / letters.length;
  if (/_{3,}|\.{5,}|\[\s*\]|☐|□/.test(t)) return false;
  if (/:\s*$/.test(t) && upper < 0.9) return false;
  return upper > 0.75 || HEADING_RE.test(t) || l.size > medianSize * 1.18;
}
export function medianSize(lines) { const s = lines.map(l => l.size).sort((a, b) => a - b); return s[Math.floor(s.length / 2)] || 10; }

/** Nearest heading above position y on page. */
function headingAbove(lines, page, y, med) {
  let best = null;
  for (const l of lines) if (l.page === page && l.y > y + 1 && isHeading(l, med) && (!best || l.y < best.y)) best = l;
  return best?.text || '';
}

const textIn = (segs, lo, hi) => clean(segs.filter(s => s.x1 > lo && s.x0 < hi).map(s => s.str).join(' '));

/** Fillable fields in reading order, with what's printed around each. */
export async function describeFields(doc, lines) {
  const ld = await PDFDocument.load(doc.bytes, { updateMetadata: false });
  let form; try { form = ld.getForm(); } catch { return []; }
  const pages = ld.getPages();
  const refIdx = new Map(pages.map((p, i) => [p.ref.toString(), i]));
  const annotIdx = new Map();
  pages.forEach((p, i) => { try { for (const r of p.node.Annots()?.asArray() || []) annotIdx.set(r.toString(), i); } catch {} });
  const med = medianSize(lines);
  const out = [];
  for (const f of form.getFields()) {
    let kind = null, options = [];
    if (f instanceof PDFTextField) kind = 'text';
    else if (f instanceof PDFCheckBox) kind = 'check';
    else if (f instanceof PDFRadioGroup) { kind = 'radio'; options = f.getOptions(); }
    else if (f instanceof PDFDropdown || f instanceof PDFOptionList) { kind = 'select'; options = f.getOptions(); }
    if (!kind) continue;
    let ro = false; try { ro = f.isReadOnly(); } catch {}
    let tip = ''; try { const t = f.acroField.dict.lookup(PDFName.of('TU')); tip = t?.decodeText?.() || ''; } catch {}
    let maxLen = 0, multi = false; if (kind === 'text') { try { maxLen = f.getMaxLength() || 0; multi = f.isMultiline(); } catch {} }
    const ws = f.acroField.getWidgets();
    let page = 0, rect = null;
    for (const w of ws) {
      let pi = -1;
      try { const P = w.P(); if (P) pi = refIdx.get(P.toString()) ?? -1; } catch {}
      if (pi < 0) { const r = ld.context.getObjectRef(w.dict); if (r) pi = annotIdx.get(r.toString()) ?? -1; }
      const rc = w.getRectangle();
      if (!rect) { rect = rc; page = Math.max(0, pi); }
    }
    if (!rect) continue;
    const name = f.getName();
    const cy = rect.y + rect.height / 2, pg = page + 1;
    const pl = lines.filter(l => l.page === pg);
    const tol = l => Math.max(rect.height * 0.6, l.size * 0.9);
    const same = pl.filter(l => Math.abs(l.y + l.size * 0.3 - cy) < tol(l));
    const left = clean(same.map(l => textIn(l.segs.filter(s => s.x1 <= rect.x + 3 && s.x1 > rect.x - 320), -1e9, 1e9)).join(' ')).slice(-140);
    const right = kind === 'check' || kind === 'radio' ? clean(same.map(l => { const s = l.segs.find(s => s.x0 >= rect.x + rect.width - 2 && s.x0 < rect.x + rect.width + 40); return s ? s.str : ''; }).join(' ')).slice(0, 100) : '';
    const aboveL = pl.filter(l => l.y > rect.y + rect.height - 3 && l.y < rect.y + rect.height + 26 && l.segs.some(s => s.x1 > rect.x - 12 && s.x0 < rect.x + rect.width + 12)).sort((a, b) => a.y - b.y)[0];
    const above = aboveL ? textIn(aboveL.segs, rect.x - 12, rect.x + rect.width + 12).slice(0, 160) : '';
    const inside = clean(pl.filter(l => l.y >= rect.y - 1 && l.y <= rect.y + rect.height).map(l => textIn(l.segs, rect.x, rect.x + rect.width)).join(' ')).slice(0, 100);
    const belowL = pl.filter(l => l.y < rect.y && l.y > rect.y - 16 && l.segs.some(s => s.x1 > rect.x && s.x0 < rect.x + rect.width)).sort((a, b) => b.y - a.y)[0];
    const below = belowL ? textIn(belowL.segs, rect.x, rect.x + rect.width).slice(0, 80) : '';
    // Lines above the field, nearest first, up to its section heading: "Beneficial owner 2", "Director 1"…
    const ctx = [];
    for (const l of pl.filter(l => l.y > rect.y + rect.height + 2).sort((a, b) => a.y - b.y)) { if (l === aboveL) continue; ctx.push(l.text.slice(0, 120)); if (ctx.length >= 8 || isHeading(l, med)) break; }
    const near = [left && `left: ${left}`, above && `above: ${above}`, right && `right: ${right}`, inside && `inside: ${inside}`, below && `below: ${below}`, ctx.length && `lines above, nearest first: ${ctx.slice(0, 4).join(' / ')}`].filter(Boolean).join(' · ');
    out.push({ name, nice: niceName(name), kind, options, ro, tip: clean(tip), maxLen, multi, page: pg, rect: [rect.x, rect.y, rect.width, rect.height], left, right, above, inside, below, ctx, near, section: headingAbove(lines, pg, rect.y + rect.height, med) });
  }
  out.sort((a, b) => a.page - b.page || (Math.abs(b.rect[1] - a.rect[1]) > 4 ? b.rect[1] - a.rect[1] : a.rect[0] - b.rect[0]));
  out.forEach((f, i) => (f.id = 'f' + (i + 1)));
  return out;
}

/** Lines worth showing a matcher for a flat form: anything with letters, headings marked. */
export function flatLines(lines) {
  const med = medianSize(lines);
  return lines.filter(l => /[A-Za-zÀ-ÿ]{2,}/.test(l.text)).map(l => ({ ...l, heading: isHeading(l, med) }));
}

export async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export async function fingerprint(doc, fields, lines) {
  if (fields.length) return 'acro:' + await sha256(JSON.stringify([doc.proxies.length, fields.map(f => [f.name, f.kind, f.page]).sort()]));
  return 'flat:' + await sha256(JSON.stringify([doc.proxies.length, lines.map(l => norm(l.text).replace(/\d+/g, '#'))]));
}

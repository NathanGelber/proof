// Word (.docx) and Excel (.xlsx) forms: find where answers go, and write them back in place.
//
// Both formats are zip files of XML. Proof edits that XML directly so the counterparty gets
// their own file back with its formatting, styles, protection and validation untouched.
// Each answer spot ("slot") is described in the same shape as a PDF form field, so the same
// matching, review, saved-forms and fill-record code handles all three formats.

import JSZip from 'jszip';
import { isHeading as pdfHeading } from './extract.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const XS = 'http://www.w3.org/XML/1998/namespace';
const SS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const clean = s => (s || '').replace(/\s+/g, ' ').trim();
const kidsNS = (n, ns, name) => [...(n?.childNodes || [])].filter(c => c.nodeType === 1 && c.namespaceURI === ns && c.localName === name);
const kid = (n, ns, name) => kidsNS(n, ns, name)[0] || null;
const allNS = (n, ns, name) => [...n.getElementsByTagNameNS(ns, name)];
const attr = (n, name, ns = W) => n?.getAttributeNS(ns, name) ?? n?.getAttribute('w:' + name) ?? null;
const ancestor = (n, ns, name, stop) => { for (let p = n.parentNode; p && p !== stop; p = p.parentNode) if (p.nodeType === 1 && p.namespaceURI === ns && p.localName === name) return p; return null; };
const parse = s => new DOMParser().parseFromString(s, 'application/xml');
const decl = s => (/^<\?xml[^>]*\?>/.exec(s) || ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'])[0];
const serialize = (dom, original) => decl(original) + '\r\n' + new XMLSerializer().serializeToString(dom).replace(/^<\?xml[^>]*\?>\s*/, '');
const labelLike = t => t && t.length <= 160 && t.split(' ').length <= 22 && /[A-Za-zÀ-ÿ]/.test(t);

export const isOfficeName = n => /\.(docx|xlsx|docm|xlsm)$/i.test(n || '');
export const officeKind = n => (/\.(xlsx|xlsm)$/i.test(n) ? 'xlsx' : 'docx');

const MAX_FILE = 50 * 1024 * 1024, MAX_PART = 100 * 1024 * 1024, MAX_TOTAL = 300 * 1024 * 1024, MAX_ENTRIES = 10000;

export async function loadOffice(bytes, name) {
  if (bytes.length > MAX_FILE) throw new Error(`${name} is larger than 50 MB, which is more than any form should be.`);
  let zip; try { zip = await JSZip.loadAsync(bytes); } catch { throw new Error('This file isn’t a readable Word or Excel file. Old .doc and .xls files need saving as .docx or .xlsx in Word or Excel first.'); }
  // A small file that unpacks to gigabytes (a "zip bomb") would hang Proof: check sizes before reading anything.
  const files = Object.values(zip.files);
  let total = 0;
  if (files.length > MAX_ENTRIES) throw new Error(`${name} has too many parts to be a normal Word or Excel file.`);
  for (const f of files) { const n = f._data?.uncompressedSize || 0; total += n; if (n > MAX_PART || total > MAX_TOTAL) throw new Error(`${name} unpacks to far more than its size. Proof won’t open it.`); }
  if (zip.file('word/document.xml')) return docx(zip, name);
  if (zip.file('xl/workbook.xml')) return xlsx(zip, name);
  throw new Error('This file isn’t a Word or Excel document.');
}

// ================================================================ Word
const BOX_CHARS = '☐□❑❒';
const BOX_SYMS = new Set(['F06F', 'F0A8', 'F071', 'F072', 'F0A1', '006F', '00A8']);
function symChar(n) { const c = (attr(n, 'char') || '').toUpperCase(); return BOX_SYMS.has(c) ? '☐' : String.fromCharCode(parseInt(c.replace(/^F0/, ''), 16) || 32); }

/** The visible text of a paragraph as atoms, each pointing at the node it came from. */
function atomsOf(p) {
  const out = [];
  for (const r of allNS(p, W, 'r')) {
    if (ancestor(r, W, 'p', null) !== p) continue; // text boxes etc.
    if (ancestor(r, W, 'del', p) || ancestor(r, W, 'moveFrom', p)) continue;
    const rPr = kid(r, W, 'rPr'); const u = kid(rPr, W, 'u'); const under = !!u && attr(u, 'val') !== 'none';
    const sdt = ancestor(r, W, 'sdt', p);
    if (sdt && kid(kid(sdt, W, 'sdtPr'), W, 'showingPlcHdr')) continue; // "Click or tap here to enter text."
    for (const c of r.childNodes) {
      if (c.nodeType !== 1 || c.namespaceURI !== W) continue;
      const base = { node: c, run: r, under, sdt };
      if (c.localName === 't') out.push({ ...base, kind: 't', text: c.textContent });
      else if (c.localName === 'tab' || c.localName === 'ptab') out.push({ ...base, kind: 'tab', text: '\t' });
      else if (c.localName === 'br' || c.localName === 'cr') out.push({ ...base, kind: 'br', text: ' ' });
      else if (c.localName === 'sym') out.push({ ...base, kind: 'sym', text: symChar(c) });
      else if (c.localName === 'noBreakHyphen') out.push({ ...base, kind: 'br', text: '-' });
    }
  }
  return out;
}
const atomText = atoms => atoms.map(a => a.text).join('');

/** Blanks in a paragraph: underscores, dot leaders, or underlined spaces and tabs. [[start, end]] */
function blanksOf(atoms) {
  const text = atomText(atoms); const out = [];
  for (const m of text.matchAll(/_{3,}|\.{4,}|…{2,}/g)) out.push([m.index, m.index + m[0].length]);
  let pos = 0, run = null;
  for (const a of atoms) {
    const blank = a.under && !a.sdt && /^[\s\t]+$/.test(a.text) && a.text.length;
    if (blank) { if (!run) run = [pos, pos]; run[1] = pos + a.text.length; } else if (run) { if (run[1] - run[0] >= 1 && (text.slice(run[0], run[1]).includes('\t') || run[1] - run[0] >= 3)) out.push(run); run = null; }
    pos += a.text.length;
  }
  if (run && (text.slice(run[0], run[1]).includes('\t') || run[1] - run[0] >= 3)) out.push(run);
  return out.filter(([s, e]) => !out.some(([s2, e2]) => (s2 < s && e2 >= e) || (s2 <= s && e2 > e))).sort((a, b) => a[0] - b[0]);
}
/** Tick boxes in a paragraph: ☐ characters, Wingdings boxes, or "[ ]". [[start, end, optionText]] */
function boxesOf(atoms) {
  const text = atomText(atoms); const out = [];
  let pos = 0;
  for (const a of atoms) { if (!a.sdt) for (let i = 0; i < a.text.length; i++) if (BOX_CHARS.includes(a.text[i])) out.push([pos + i, pos + i + 1]); pos += a.text.length; }
  for (const m of text.matchAll(/\[\s{0,3}\]/g)) out.push([m.index, m.index + m[0].length]);
  out.sort((a, b) => a[0] - b[0]);
  return out.map(([s, e], i) => { const next = out[i + 1]?.[0] ?? text.length; return [s, e, clean(text.slice(e, next).split(/\t|\s{3,}/)[0] || '').slice(0, 80)]; });
}

function newRun(doc, rPrFrom, text) {
  const r = doc.createElementNS(W, 'w:r');
  if (rPrFrom) { const c = rPrFrom.cloneNode(true); for (const x of kidsNS(c, W, 'rStyle')) if (/placeholder/i.test(attr(x, 'val') || '')) x.remove(); r.append(c); }
  const lines = String(text).split('\n');
  lines.forEach((l, i) => { if (i) r.append(doc.createElementNS(W, 'w:br')); const t = doc.createElementNS(W, 'w:t'); t.setAttributeNS(XS, 'xml:space', 'preserve'); t.textContent = l; r.append(t); });
  return r;
}
/** Replace characters [start, end) of a paragraph's visible text with `text`. */
function replaceRange(doc, p, start, end, text) {
  const atoms = atomsOf(p); let pos = 0, done = false;
  for (const a of atoms) {
    const a0 = pos, a1 = pos + a.text.length; pos = a1;
    if (a1 <= start || a0 >= end || !a.text.length) continue;
    const s = Math.max(start, a0) - a0, e = Math.min(end, a1) - a0;
    if (a.kind === 't') {
      const t = a.node.textContent;
      if (!done && text.includes('\n')) { a.node.textContent = t.slice(0, s); const r = newRun(doc, kid(a.run, W, 'rPr'), text); a.run.after(r); if (t.slice(e)) r.after(newRun(doc, kid(a.run, W, 'rPr'), t.slice(e))); }
      else a.node.textContent = t.slice(0, s) + (done ? '' : text) + t.slice(e);
      a.node.setAttributeNS(XS, 'xml:space', 'preserve'); done = true;
    } else if (a.kind === 'sym' && !done && text.length === 1) {
      a.node.setAttributeNS(W, 'w:char', text === '☒' ? 'F0FD' : a.node.getAttributeNS(W, 'char')); done = true;
    } else {
      if (!done) { const t = doc.createElementNS(W, 'w:t'); t.setAttributeNS(XS, 'xml:space', 'preserve'); t.textContent = text; a.node.replaceWith(t); done = true; }
      else a.node.remove();
    }
  }
  return done;
}
function setParagraphText(doc, p, text, rPrFrom) {
  for (const r of kidsNS(p, W, 'r')) r.remove();
  p.append(newRun(doc, rPrFrom || kid(kid(p, W, 'pPr'), W, 'rPr'), text));
}

/** Visible text of paragraph p before and after `node` (a run, control or field inside it). */
function around(p, node) {
  let before = '', after = '';
  for (const a of atomsOf(p)) {
    if (node.contains(a.run)) continue;
    if (node.compareDocumentPosition(a.run) & Node.DOCUMENT_POSITION_PRECEDING) before += a.text; else after += a.text;
  }
  return [clean(before).slice(-140), clean(after).split(/\t|\s{3,}/)[0]?.slice(0, 80) || ''];
}
/** Run formatting for an answer: the cell's own paragraph formatting, else the label's without bold or italics. */
function answerRPr(targetP, labelRun) {
  const own = kid(kid(targetP, W, 'pPr'), W, 'rPr'); if (own) return own;
  const lr = kid(labelRun, W, 'rPr'); if (!lr) return null;
  const c = lr.cloneNode(true); for (const n of ['b', 'bCs', 'i', 'iCs', 'u', 'caps', 'color', 'highlight', 'shd']) kidsNS(c, W, n).forEach(x => x.remove()); return c;
}

const HEADING_STYLE = /heading|kop|titel|title|ueberschrift|überschrift|titre/i;
function wordHeading(p, text) {
  const st = attr(kid(kid(p, W, 'pPr'), W, 'pStyle'), 'val') || '';
  if (HEADING_STYLE.test(st)) return true;
  const runs = kidsNS(p, W, 'r').filter(r => clean(r.textContent));
  const bold = runs.length && runs.every(r => { const b = kid(kid(r, W, 'rPr'), W, 'b'); return b && attr(b, 'val') !== '0' && attr(b, 'val') !== 'false'; });
  if (bold && text.length <= 80 && !/[:_]\s*$/.test(text) && !/_{3,}/.test(text)) return true;
  return pdfHeading({ text, size: 10 }, 10);
}

async function docx(zip, name) {
  const src = await zip.file('word/document.xml').async('string');
  const doc = parse(src);
  if (doc.getElementsByTagName('parsererror').length) throw new Error('The Word file is damaged.');
  const body = kid(doc.documentElement, W, 'body');
  // Every paragraph in reading order, with its text and whether it's a heading.
  const paras = allNS(body, W, 'p').filter(p => !ancestor(p, W, 'txbxContent', body));
  const pIndex = new Map(paras.map((p, i) => [p, i]));
  const ptext = paras.map(p => clean(atomText(atomsOf(p))));
  const head = paras.map((p, i) => !!ptext[i] && wordHeading(p, ptext[i]));
  const sectionAt = i => { for (let k = i - 1; k >= 0; k--) if (head[k]) return ptext[k]; return ''; };
  const ctxAt = (i, extra = []) => { const out = [...extra]; for (let k = i - 1; k >= 0 && out.length < 8; k--) { if (ptext[k]) out.push(ptext[k].slice(0, 120)); if (head[k]) break; } return out; };
  const cellText = tc => clean(allNS(tc, W, 'p').map(p => atomText(atomsOf(p))).join(' '));
  const leftCell = node => { const tc = ancestor(node, W, 'tc', body); const prev = tc?.previousElementSibling; return prev && prev.localName === 'tc' ? cellText(prev) : ''; };
  const slots = []; const busy = new Set(); // paragraphs whose spots are covered by a control or field
  const add = (s, order) => { s.page = 0; s.ro = false; s.maxLen ||= 0; s.options ||= []; s.inside = ''; s.below = ''; s.nice ||= ''; s.tip ||= ''; s.right ||= ''; s.above ||= ''; s.left ||= ''; s.near = [s.left && `left: ${s.left}`, s.above && `above: ${s.above}`, s.right && `option: ${s.right}`, s.ctx?.length && `lines above, nearest first: ${s.ctx.slice(0, 4).join(' / ')}`].filter(Boolean).join(' · '); s.order = order; slots.push(s); };

  // ---- content controls
  let nSdt = 0;
  for (const sdt of allNS(body, W, 'sdt')) {
    const pr = kid(sdt, W, 'sdtPr'), content = kid(sdt, W, 'sdtContent'); if (!pr || !content) continue;
    if (kid(pr, W, 'docPartObj') || kid(pr, W, 'picture') || kid(pr, W, 'group') || kid(pr, W, 'citation') || kid(pr, W, 'bibliography')) continue;
    if (kidsNS(content, W, 'tr').length || kidsNS(content, W, 'tbl').length) continue; // repeating sections
    const id = 'sdt' + (++nSdt);
    const alias = attr(kid(pr, W, 'alias'), 'val') || '', tag = attr(kid(pr, W, 'tag'), 'val') || '';
    const p = sdt.parentNode.localName === 'p' ? sdt.parentNode : allNS(content, W, 'p')[0];
    const pi = pIndex.get(p) ?? 0;
    const inline = sdt.parentNode.localName === 'p';
    const [bef, aft] = inline ? around(p, sdt) : ['', ''];
    const left = bef || leftCell(sdt);
    const placeholder = !!kid(pr, W, 'showingPlcHdr');
    const cb = kid(pr, W14, 'checkbox');
    const where = `Content control${alias ? ' “' + alias + '”' : ''}`;
    const base = { name: id, nice: tag, tip: alias, left, above: left ? '' : ptext[pi - 1] || '', section: sectionAt(pi), ctx: ctxAt(pi), where };
    if (cb) {
      const chk = kid(cb, W14, 'checked');
      add({ ...base, kind: 'check', right: aft, cur: chk && /^(1|true)$/.test(chk.getAttributeNS(W14, 'val') || ''), write(v) {
        let c = kid(cb, W14, 'checked'); if (!c) { c = doc.createElementNS(W14, 'w14:checked'); cb.prepend(c); }
        c.setAttributeNS(W14, 'w14:val', v ? '1' : '0');
        const st = kid(cb, W14, v ? 'checkedState' : 'uncheckedState');
        const ch = String.fromCharCode(parseInt(st?.getAttributeNS(W14, 'val') || (v ? '2612' : '2610'), 16));
        const t = allNS(content, W, 't')[0]; if (t) t.textContent = ch; else { const s = allNS(content, W, 'sym')[0]; if (s) s.setAttributeNS(W, 'w:char', v ? 'F0FD' : 'F0A8'); }
      } }, [pi, 0]);
      busy.add(p); continue;
    }
    const filled = !placeholder && clean(content.textContent);
    if (filled) continue; // already answered by the counterparty
    const list = kid(pr, W, 'dropDownList') || kid(pr, W, 'comboBox');
    const date = kid(pr, W, 'date');
    const options = list ? kidsNS(list, W, 'listItem').map(li => attr(li, 'displayText') || attr(li, 'value')).filter(Boolean) : [];
    const df = date ? attr(kid(date, W, 'dateFormat'), 'val') : '';
    add({ ...base, tip: [alias, df && `(${df})`].filter(Boolean).join(' '), kind: list && kid(pr, W, 'dropDownList') ? 'select' : 'text', options, write(v) {
      const ts = allNS(content, W, 't');
      for (const x of kidsNS(pr, W, 'showingPlcHdr')) x.remove();
      for (const rs of allNS(content, W, 'rStyle')) if (/placeholder/i.test(attr(rs, 'val') || '')) rs.remove();
      if (ts.length && !String(v).includes('\n')) { ts[0].textContent = String(v); ts[0].setAttributeNS(XS, 'xml:space', 'preserve'); ts.slice(1).forEach(t => (t.textContent = '')); return; }
      const cp = allNS(content, W, 'p')[0];
      const rPr = kid(allNS(content, W, 'r')[0], W, 'rPr');
      if (cp) setParagraphText(doc, cp, String(v), rPr);
      else { for (const r of kidsNS(content, W, 'r')) r.remove(); content.append(newRun(doc, rPr, String(v))); }
    } }, [pi, 0]);
    busy.add(p);
  }

  // ---- legacy form fields
  let nFf = 0;
  for (const fc of allNS(body, W, 'fldChar')) {
    if (attr(fc, 'fldCharType') !== 'begin') continue;
    const ff = kid(fc, W, 'ffData'); if (!ff) continue;
    const r0 = fc.parentNode, p = ancestor(r0, W, 'p', body); if (!p) continue;
    const runs = kidsNS(p, W, 'r'); const i0 = runs.indexOf(r0);
    let sep = -1, end = -1;
    for (let i = i0 + 1; i < runs.length; i++) { const f = kid(runs[i], W, 'fldChar'); const t = f && attr(f, 'fldCharType'); if (t === 'separate' && sep < 0) sep = i; if (t === 'end') { end = i; break; } }
    if (end < 0) continue;
    const pi = pIndex.get(p) ?? 0;
    const [bef] = around(p, r0);
    const left = bef || leftCell(p);
    const help = attr(kid(ff, W, 'helpText'), 'val') || attr(kid(ff, W, 'statusText'), 'val') || '';
    const nm = attr(kid(ff, W, 'name'), 'val') || '';
    const id = 'ff' + (++nFf);
    const after = clean(atomsOf(p).filter(a => runs.indexOf(a.run) > end).map(a => a.text).join('')).split(/\t|\s{3,}/)[0].slice(0, 80);
    const base = { name: id, nice: nm, tip: help, left, above: left ? '' : ptext[pi - 1] || '', section: sectionAt(pi), ctx: ctxAt(pi), where: `Form field${nm ? ' “' + nm + '”' : ''}` };
    const cbx = kid(ff, W, 'checkBox'), dd = kid(ff, W, 'ddList'), ti = kid(ff, W, 'textInput');
    if (cbx) add({ ...base, kind: 'check', right: after, write(v) { for (const c of kidsNS(cbx, W, 'checked')) c.remove(); const c = doc.createElementNS(W, 'w:checked'); c.setAttributeNS(W, 'w:val', v ? '1' : '0'); cbx.append(c); } }, [pi, 0]);
    else if (dd) {
      const opts = kidsNS(dd, W, 'listEntry').map(x => attr(x, 'val'));
      add({ ...base, kind: 'select', options: opts, write(v) { const i = opts.indexOf(String(v)); if (i < 0) return; for (const c of kidsNS(dd, W, 'result')) c.remove(); const c = doc.createElementNS(W, 'w:result'); c.setAttributeNS(W, 'w:val', String(i)); dd.prepend(c); } }, [pi, 0]);
    } else {
      const ml = +(attr(kid(ti, W, 'maxLength'), 'val') || 0);
      add({ ...base, kind: 'text', maxLen: ml, write(v) {
        const rs = kidsNS(p, W, 'r'); const a = rs.indexOf(r0); let s = -1, e = -1;
        for (let i = a + 1; i < rs.length; i++) { const f = kid(rs[i], W, 'fldChar'); const t = f && attr(f, 'fldCharType'); if (t === 'separate' && s < 0) s = i; if (t === 'end') { e = i; break; } }
        const result = s >= 0 ? rs.slice(s + 1, e) : [];
        const rPr = kid(result[0] || rs[e], W, 'rPr');
        result.forEach(r => r.remove());
        if (s < 0) { const sr = doc.createElementNS(W, 'w:r'); const f = doc.createElementNS(W, 'w:fldChar'); f.setAttributeNS(W, 'w:fldCharType', 'separate'); sr.append(f); rs[e].before(sr); }
        rs[e].before(newRun(doc, rPr, String(v)));
      } }, [pi, 0]);
    }
    busy.add(p);
  }

  // ---- tables: label | blank cells, and column tables (a header row with blank rows under it)
  let nT = 0;
  for (const tbl of allNS(body, W, 'tbl')) {
    nT++;
    const rows = kidsNS(tbl, W, 'tr');
    const grid = rows.map(tr => { let col = 0; return kidsNS(tr, W, 'tc').map(tc => { const span = +(attr(kid(kid(tc, W, 'tcPr'), W, 'gridSpan'), 'val') || 1); const c = { tc, col, span, text: cellText(tc), special: allNS(tc, W, 'sdt').length + allNS(tc, W, 'fldChar').length + allNS(tc, W, 'tbl').length + allNS(tc, W, 'drawing').length > 0, vmerge: !!kid(kid(tc, W, 'tcPr'), W, 'vMerge') && attr(kid(kid(tc, W, 'tcPr'), W, 'vMerge'), 'val') !== 'restart' }; col += span; return c; }); });
    const firstP = allNS(tbl, W, 'p')[0]; const tpi = pIndex.get(firstP) ?? 0;
    const empty = c => !c.text && !c.special && !c.vmerge;
    let header = null, dataN = 0;
    grid.forEach((cells, ri) => {
      const filled = cells.filter(c => c.text);
      const isData = header && cells.filter(empty).length >= 1 && filled.length <= 1 && (!filled.length || filled[0] === cells[0] && filled[0].text.length <= 24);
      if (isData) {
        dataN++;
        const lab = cells[0].text;
        for (const c of cells) {
          if (!empty(c)) continue;
          const h = header.find(x => x.col <= c.col && c.col < x.col + x.span);
          if (!h || !h.text) continue;
          const tc = c.tc;
          add({ name: `t${nT}r${ri + 1}c${c.col + 1}`, kind: 'text', above: h.text, nice: `${h.text} ${dataN}`, left: '', section: sectionAt(tpi), ctx: [lab, ...grid.slice(0, ri).reverse().map(r => r[0]?.text).filter(Boolean), ...ctxAt(tpi)].filter(Boolean).slice(0, 8), where: `Table ${nT}, row ${ri + 1}`, write(v) { const cp = allNS(tc, W, 'p')[0]; setParagraphText(doc, cp, String(v), answerRPr(cp, allNS(h.tc, W, 'r')[0])); } }, [pIndex.get(allNS(tc, W, 'p')[0]) ?? tpi, 0]);
        }
        return;
      }
      dataN = 0;
      if (filled.length >= 2 && filled.every(c => c.text.length <= 60) && ri + 1 < grid.length && grid[ri + 1].some(c => empty(c) && filled.some(f => f.col <= c.col && c.col < f.col + f.span)) && grid[ri + 1].filter(c => c.text).length <= 1) { header = cells; return; }
      header = null;
      cells.forEach((c, i) => {
        const nx = cells[i + 1];
        if (!c.text || !nx || !empty(nx) || !labelLike(c.text)) return;
        const tc = nx.tc;
        add({ name: `t${nT}r${ri + 1}c${nx.col + 1}`, kind: 'text', left: c.text, section: sectionAt(tpi), ctx: [...grid.slice(0, ri).reverse().map(r => r.map(x => x.text).filter(Boolean).join(' ')).filter(Boolean), ...ctxAt(tpi)].slice(0, 8), where: `Table ${nT}, row ${ri + 1}`, write(v) { const cp = allNS(tc, W, 'p')[0]; setParagraphText(doc, cp, String(v), answerRPr(cp, allNS(c.tc, W, 'r')[0])); } }, [pIndex.get(allNS(tc, W, 'p')[0]) ?? tpi, 0]);
      });
    });
  }

  // ---- blanks and tick boxes inside paragraphs
  paras.forEach((p, pi) => {
    if (busy.has(p)) return;
    const atoms = atomsOf(p); const text = atomText(atoms); if (!text.trim()) return;
    const blanks = blanksOf(atoms);
    blanks.forEach(([s, e], k) => {
      const prevEnd = k ? blanks[k - 1][1] : 0;
      let label = clean(text.slice(prevEnd, s));
      const next = blanks[k + 1]?.[0] ?? text.length;
      const tail = clean(text.slice(e, next));
      add({ name: `p${pi + 1}b${k + 1}`, kind: 'text', left: label || leftCell(p), above: label ? '' : (ptext[pi - 1] || ''), below: '', inside: tail && !label ? tail : '', section: sectionAt(pi), ctx: ctxAt(pi), where: `Paragraph ${pi + 1}`, write(v) { replaceRange(doc, p, s, e, ' ' + String(v) + ' '); } }, [pi, -s]);
    });
    const boxes = boxesOf(atoms);
    if (boxes.length) {
      const question = clean(text.slice(0, boxes[0][0])) || leftCell(p) || ptext[pi - 1] || '';
      boxes.forEach(([s, e, opt], k) => {
        if (!opt && boxes.length > 1) return;
        add({ name: `p${pi + 1}x${k + 1}`, kind: 'check', left: question, right: opt, section: sectionAt(pi), ctx: ctxAt(pi), where: `Paragraph ${pi + 1}`, write(v) { if (!v) return; const t = atomText(atomsOf(p)).slice(s, e); replaceRange(doc, p, s, e, t.startsWith('[') ? '[X]' : '☒'); } }, [pi, -s]);
      });
    }
  });

  slots.sort((a, b) => a.order[0] - b.order[0] || b.order[1] - a.order[1]);
  slots.forEach((s, i) => (s.id = 'f' + (i + 1)));
  return {
    kind: 'docx', name, slots, dom: doc,
    async save(values) {
      // Within a paragraph, write from the end backwards so earlier positions stay valid.
      const order = [...slots].sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
      for (const s of order) if (values.has(s.name)) s.write(values.get(s.name));
      zip.file('word/document.xml', serialize(doc, src));
      return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    },
  };
}

// ================================================================ Excel
const colNum = s => s.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colName = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const splitRef = r => { const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(r); return m ? [colNum(m[1]), +m[2]] : null; };
function rangeCells(ref) {
  const [a, b = a] = ref.split(':'); const p = splitRef(a), q = splitRef(b); if (!p || !q) return [];
  const out = []; for (let r = Math.min(p[1], q[1]); r <= Math.max(p[1], q[1]); r++) for (let c = Math.min(p[0], q[0]); c <= Math.max(p[0], q[0]); c++) out.push([c, r]); return out;
}

async function xlsx(zip, name) {
  const wbSrc = await zip.file('xl/workbook.xml').async('string'); const wb = parse(wbSrc);
  const relSrc = await zip.file('xl/_rels/workbook.xml.rels')?.async('string'); const rels = relSrc ? parse(relSrc) : null;
  const target = id => { const r = rels && [...rels.getElementsByTagName('Relationship')].find(x => x.getAttribute('Id') === id); if (!r) return null; const t = r.getAttribute('Target'); return t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, ''); };
  const ssSrc = await zip.file('xl/sharedStrings.xml')?.async('string');
  const shared = ssSrc ? allNS(parse(ssSrc), SS, 'si').map(si => allNS(si, SS, 't').filter(t => !ancestor(t, SS, 'rPh', si)).map(t => t.textContent).join('')) : [];
  const defined = new Map(allNS(wb, SS, 'definedName').map(d => [d.getAttribute('name'), d.textContent]));
  const sheets = [];
  for (const sh of allNS(wb, SS, 'sheet')) {
    const path = target(sh.getAttributeNS(RELNS, 'id') || sh.getAttribute('r:id')); if (!path || !zip.file(path)) continue;
    const src = await zip.file(path).async('string'); const dom = parse(src);
    const cells = new Map();
    for (const c of allNS(dom, SS, 'c')) {
      const ref = c.getAttribute('r'); const p = ref && splitRef(ref); if (!p) continue;
      const t = c.getAttribute('t'); const v = kid(c, SS, 'v')?.textContent ?? '';
      const text = t === 's' ? shared[+v] ?? '' : t === 'inlineStr' ? allNS(c, SS, 't').map(x => x.textContent).join('') : v;
      cells.set(p[0] + ',' + p[1], { el: c, col: p[0], row: p[1], text: clean(text), formula: !!kid(c, SS, 'f'), styled: c.hasAttribute('s') });
    }
    const merges = allNS(dom, SS, 'mergeCell').map(m => m.getAttribute('ref')).map(r => { const cs = rangeCells(r); return cs.length ? { tl: cs[0], br: cs[cs.length - 1], cells: cs } : null; }).filter(Boolean);
    const hiddenRows = new Set(allNS(dom, SS, 'row').filter(r => r.getAttribute('hidden') === '1' || r.getAttribute('hidden') === 'true').map(r => +r.getAttribute('r')));
    sheets.push({ name: sh.getAttribute('name'), state: sh.getAttribute('state') || 'visible', path, src, dom, cells, merges, hiddenRows });
  }
  const sheetByName = n => sheets.find(s => s.name.replace(/^'|'$/g, '') === n.replace(/^'|'$/g, ''));
  function listValues(sh, f) {
    f = (f || '').trim();
    if (/^".*"$/.test(f)) return f.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    if (defined.has(f)) f = defined.get(f);
    const m = /^(?:'?([^'!]+)'?!)?(\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?)$/.exec(f); if (!m) return [];
    const s2 = m[1] ? sheetByName(m[1]) : sh; if (!s2) return [];
    return rangeCells(m[2].replace(/\$/g, '')).map(([c, r]) => s2.cells.get(c + ',' + r)?.text).filter(Boolean);
  }
  const slots = [];
  sheets.forEach((sh, si) => {
    if (sh.state !== 'visible') return;
    const get = (c, r) => sh.cells.get(c + ',' + r);
    const mergeAt = (c, r) => sh.merges.find(m => m.cells.some(([x, y]) => x === c && y === r));
    const validation = new Map();
    for (const dv of allNS(sh.dom, SS, 'dataValidation').concat([...sh.dom.getElementsByTagName('*')].filter(n => n.localName === 'dataValidation' && n.namespaceURI !== SS))) {
      if (dv.getAttribute('type') !== 'list') continue;
      const f1 = [...dv.childNodes].find(n => n.localName === 'formula1'); const fx = f1 ? ([...f1.childNodes].find(n => n.localName === 'f')?.textContent ?? f1.textContent) : '';
      const sq = dv.getAttribute('sqref') || [...dv.childNodes].find(n => n.localName === 'sqref')?.textContent || '';
      const vals = listValues(sh, fx);
      for (const part of sq.split(/\s+/)) for (const [c, r] of rangeCells(part)) validation.set(c + ',' + r, vals);
    }
    const covered = (c, r) => { const m = mergeAt(c, r); return m && (m.tl[0] !== c || m.tl[1] !== r); };
    const isEmpty = (c, r) => { const x = get(c, r); return !covered(c, r) && (!x || (!x.text && !x.formula)); };
    const inputish = (c, r, label) => !!get(c, r) || validation.has(c + ',' + r) || !!mergeAt(c, r) || /[:?]\s*$/.test(label);
    const rows = [...new Set([...sh.cells.values()].map(c => c.row))].sort((a, b) => a - b);
    const rowTexts = r => [...sh.cells.values()].filter(c => c.row === r && c.text).sort((a, b) => a.col - b.col);
    const firstText = r => rowTexts(r)[0]?.text || '';
    const heading = r => { const t = rowTexts(r); return t.length === 1 && pdfHeading({ text: t[0].text, size: 10 }, 10); };
    const sectionAt = r => { for (let k = r - 1; k >= 1; k--) if (heading(k)) return firstText(k); return ''; };
    const ctxAt = r => { const out = []; for (let k = r - 1; k >= 1 && out.length < 8; k--) { const t = rowTexts(k).map(c => c.text).join(' '); if (t) out.push(t.slice(0, 120)); if (heading(k)) break; } return out; };
    const addSlot = (c, r, s) => {
      const key = c + ',' + r; const vals = validation.get(key);
      s.name = `${sh.name}!${colName(c)}${r}`; s.where = (sheets.length > 1 ? sh.name + ' · ' : '') + colName(c) + r;
      s.kind = vals?.length ? 'select' : 'text'; s.options = vals || []; s.page = 0; s.ro = false; s.maxLen = 0; s.tip = ''; s.right = ''; s.inside = ''; s.below = '';
      s.left ||= ''; s.above ||= ''; s.nice ||= ''; s.section = sectionAt(r); s.ctx ||= ctxAt(r);
      s.near = [s.left && `left: ${s.left}`, s.above && `column header: ${s.above}`, s.ctx.length && `rows above, nearest first: ${s.ctx.slice(0, 4).join(' / ')}`].filter(Boolean).join(' · ');
      s.order = [si, r, c]; s.write = v => setCell(sh, c, r, v);
      if (!slots.some(x => x.name === s.name)) slots.push(s);
    };
    const headerRows = new Set();
    // Column tables: a row of short headers with empty input rows under it.
    for (const r of rows) {
      if (sh.hiddenRows.has(r)) continue;
      const hs = rowTexts(r).filter(c => c.text.length <= 60 && labelLike(c.text) && !covered(c.col, c.row));
      if (hs.length < 2 || !hs.every(h => isEmpty(h.col, r + 1) && inputish(h.col, r + 1, ''))) continue;
      headerRows.add(r);
      for (let k = 1, n = 0; k <= 15; k++) {
        const rr = r + k; const cellsHere = rowTexts(rr);
        const lab = cellsHere.find(c => !hs.some(h => h.col === c.col));
        if (cellsHere.some(c => hs.some(h => h.col === c.col)) || cellsHere.length > 1) break;
        if (!hs.some(h => inputish(h.col, rr, ''))) break;
        n++;
        for (const h of hs) if (isEmpty(h.col, rr)) addSlot(h.col, rr, { above: h.text, nice: `${h.text} ${n}`, ctx: [lab?.text, ...ctxAt(r + 1)].filter(Boolean) });
      }
    }
    // Label | answer pairs.
    for (const c of [...sh.cells.values()].sort((a, b) => a.row - b.row || a.col - b.col)) {
      if (!c.text || headerRows.has(c.row) || sh.hiddenRows.has(c.row) || covered(c.col, c.row) || !labelLike(c.text) || heading(c.row) && rowTexts(c.row).length === 1 && !/[:?]\s*$/.test(c.text)) continue;
      const m = mergeAt(c.col, c.row); const nc = (m ? m.br[0] : c.col) + 1;
      if (isEmpty(nc, c.row) && inputish(nc, c.row, c.text)) addSlot(nc, c.row, { left: c.text });
    }
  });
  slots.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2]);
  slots.forEach((s, i) => (s.id = 'f' + (i + 1)));

  function setCell(sh, c, r, v) {
    const dom = sh.dom; const data = allNS(dom, SS, 'sheetData')[0];
    let row = allNS(data, SS, 'row').find(x => +x.getAttribute('r') === r);
    if (!row) { row = dom.createElementNS(SS, 'row'); row.setAttribute('r', String(r)); const after = allNS(data, SS, 'row').find(x => +x.getAttribute('r') > r); after ? after.before(row) : data.append(row); }
    const ref = colName(c) + r;
    let cell = kidsNS(row, SS, 'c').find(x => x.getAttribute('r') === ref);
    row.removeAttribute('spans');
    if (!cell) { cell = dom.createElementNS(SS, 'c'); cell.setAttribute('r', ref); const after = kidsNS(row, SS, 'c').find(x => (splitRef(x.getAttribute('r')) || [0])[0] > c); after ? after.before(cell) : row.append(cell); }
    for (const x of [...cell.childNodes]) if (x.nodeType === 1 && ['v', 'is', 'f'].includes(x.localName)) x.remove();
    if (typeof v === 'number') { cell.removeAttribute('t'); const vv = dom.createElementNS(SS, 'v'); vv.textContent = String(v); cell.append(vv); return; }
    const s = typeof v === 'boolean' ? (v ? 'X' : '') : String(v);
    if (!s) { cell.removeAttribute('t'); return; }
    cell.setAttribute('t', 'inlineStr');
    const is = dom.createElementNS(SS, 'is'); const t = dom.createElementNS(SS, 't'); t.setAttributeNS(XS, 'xml:space', 'preserve'); t.textContent = s; is.append(t); cell.append(is);
  }

  return {
    kind: 'xlsx', name, slots, sheets: sheets.map(sh => ({ name: sh.name, state: sh.state, cells: sh.cells, merges: sh.merges, hiddenRows: sh.hiddenRows })),
    async save(values) {
      const touched = new Set();
      for (const s of slots) if (values.has(s.name)) { s.write(values.get(s.name)); touched.add(sheets[s.order[0]]); }
      for (const sh of touched) zip.file(sh.path, serialize(sh.dom, sh.src));
      return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    },
  };
}

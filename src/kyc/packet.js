// "Create KYC packet": instead of filling the counterparty's form, send them our own information
// sheet — the profile laid out as a PDF, with our logo, chosen documents appended and a signature block.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as host from '../host.js';
import { GROUPS, ROLES, entityKeys, personKeys, docTypeInfo } from './schema.js';
import { K, V, persist, peopleIn, todayIso, errMsg } from './vault.js';
import { render, formatDate } from './match.js';

let C = null;
export function initPacket(ctx) { C = ctx; }

const A4 = [595.28, 841.89], M = 56;
const GREY = rgb(0.38, 0.39, 0.43), INK = rgb(0.05, 0.05, 0.06), RULE = rgb(0.82, 0.83, 0.86);
const ADDRESS_PARTS = /^(reg|op)_(street|postcode|city|country)$|^op_same$/;
const NAME_PARTS = new Set(['full_name', 'first_name', 'middle_name', 'last_name', 'res_street', 'res_postcode', 'res_city', 'res_country']);
const ID_KEYS = new Set(['id_type', 'id_number', 'id_country', 'id_issued', 'id_expiry']);
const show = (ent, key) => { const r = render(ent, key, '', null); return r.missing ? '' : String(r.show ?? '').trim(); };
const fmtDay = iso => formatDate(iso, K.P?.settings?.dateFormat || 'DD-MM-YYYY');

/**
 * Everything the packet can contain, as groups of selectable items:
 * [{id, title, sub, kind: 'section'|'person'|'docs'|'sign', items: [{id, label, value, id_doc?}]}].
 * Ids are stable (profile keys, person and document ids), so a selection can be remembered.
 */
function contents(ent) {
  const groups = [];
  for (const [g, title] of [...GROUPS, ['custom', 'Other']]) {
    const items = [];
    for (const d of entityKeys(ent).filter(x => x.group === g)) {
      if (ADDRESS_PARTS.test(d.key)) continue;
      const label = d.key === 'reg_address' ? 'Registered address' : d.key === 'op_address' ? 'Business address' : d.label;
      const v = d.key === 'op_address' && ent.values.op_same?.v === 'yes' ? 'Same as the registered address' : show(ent, d.key);
      if (v) items.push({ id: 'e:' + d.key, label, value: v, bank: g === 'bank' });
    }
    if (items.length) groups.push({ id: 'g:' + g, title, kind: 'section', items });
  }
  // Each person once, with every role they hold.
  const people = new Map();
  for (const r of ROLES) peopleIn(ent, r.role).forEach((p, i) => {
    if (!people.has(p)) people.set(p, { p, roles: [], key: `${r.role}.${i + 1}` });
    people.get(p).roles.push(`${r.label} ${i + 1}`);
  });
  for (const { p, roles, key } of people.values()) {
    const name = show(ent, `${key}.full_name`) || '(no name)';
    const items = [{ id: `p:${p.id}:name`, label: 'Name', value: name, name: true }];
    for (const d of personKeys(ent)) {
      if (NAME_PARTS.has(d.key)) continue;
      if (p.kind === 'company' && ['date_of_birth', 'place_of_birth', 'country_of_birth', 'nationality', 'nationality_2', 'pep', 'pep_details', ...ID_KEYS].includes(d.key)) continue;
      const v = show(ent, `${key}.${d.key}`); if (!v) continue;
      items.push({ id: `p:${p.id}:${d.key}`, label: d.key === 'res_address' ? 'Address' : d.label, value: v, idDoc: ID_KEYS.has(d.key) });
    }
    groups.push({ id: 'p:' + p.id, title: name, sub: roles.join(', '), kind: 'person', items });
  }
  if (ent.docs.length) groups.push({ id: 'g:docs', title: 'Documents', kind: 'docs', items: ent.docs.map(d => ({ id: 'd:' + d.id, label: d.title, value: docTypeInfo(d.type)[1], doc: d })) });
  groups.push({ id: 'g:sign', title: 'Signature block', kind: 'sign', items: [{ id: 'sign', label: 'Signature block', value: '' }] });
  return groups;
}
// Shared sparingly by default: no bank details, ID numbers or documents until you tick them.
const defaultOn = it => !it.bank && !it.idDoc && !it.doc;
const cpKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ---------------------------------------------------------------- dialog
export async function createPacket(ent) {
  const { h, modal } = C;
  const groups = contents(ent);
  const all = groups.flatMap(g => g.items);
  const prefs = (ent.packet ||= { by: {}, last: null, logoH: 48 });
  // A remembered selection holds every item seen then; items added since get the default.
  const load = saved => new Set(all.filter(it => (saved && it.id in saved ? saved[it.id] : defaultOn(it))).map(it => it.id));
  let sel = load(prefs.last), from = prefs.last ? 'last' : '';
  const open = new Set();

  const cp = h('input', { type: 'text', id: 'pk-cp', spellcheck: 'false', autocomplete: 'off', list: 'pk-cps' });
  const known = Object.keys(prefs.by).map(k => prefs.by[k].name).filter(Boolean);
  const cpList = h('datalist', { id: 'pk-cps' }, known.map(n => h('option', { value: n })));
  const note = h('p', { class: 'hint pk-note' });
  cp.addEventListener('change', () => {
    const k = cpKey(cp.value), saved = prefs.by[k];
    if (saved) { sel = load(saved.sel); from = 'cp'; draw(); }
  });

  // Logo with a size slider; the preview is drawn at the size it will have on the page.
  const logoBox = h('div', { class: 'pk-logo' });
  const drawLogo = () => {
    const size = h('input', { type: 'range', min: '20', max: '120', step: '2', value: String(prefs.logoH || 48), 'aria-label': 'Logo size' });
    const img = ent.logo ? h('img', { src: ent.logo, alt: 'Logo', style: `height:${prefs.logoH || 48}px` }) : null;
    size.addEventListener('input', () => { prefs.logoH = +size.value; if (img) img.style.height = size.value + 'px'; });
    size.addEventListener('change', () => persist());
    logoBox.replaceChildren(
      img ? h('div', { class: 'pk-logo-img' }, img) : h('span', { class: 'hint' }, 'No logo'),
      h('div', { class: 'pk-logo-ctl' },
        img ? h('label', { class: 'pk-size' }, h('span', { class: 'lbl' }, 'Size'), size) : null,
        h('div', { class: 'btns' },
          h('button', { class: 'btn', onclick: pickLogo }, ent.logo ? 'Change…' : 'Add logo…'),
          ent.logo ? h('button', { class: 'btn quiet', onclick: () => { delete ent.logo; persist(); drawLogo(); } }, 'Remove') : null)));
  };
  async function pickLogo() {
    const f = await host.pickImage(); if (!f) return;
    try { ent.logo = await shrink(f); persist(); drawLogo(); } catch (e) { C.toast('Couldn’t read that image: ' + errMsg(e), 6000); }
  }
  drawLogo();

  // What goes in: every group with a box that ticks or clears it all, opened to tick single items.
  const list = h('div', { class: 'pk-tree' });
  const count = h('span', { class: 'pk-count' });
  function setItem(g, it, on) {
    on ? sel.add(it.id) : sel.delete(it.id);
    // A person without their name isn't sent; ticking any of their details brings the name back.
    if (g.kind === 'person') { const nm = g.items[0]; if (it === nm && !on) g.items.forEach(x => sel.delete(x.id)); else if (on) sel.add(nm.id); }
  }
  function draw() {
    list.replaceChildren(...groups.map(g => {
      const n = g.items.filter(it => sel.has(it.id)).length, single = g.kind === 'sign';
      const gcb = h('input', { type: 'checkbox', 'aria-label': g.title }); gcb.checked = n > 0 && n === g.items.length; gcb.indeterminate = n > 0 && n < g.items.length;
      gcb.onchange = () => { g.items.forEach(it => setItem(g, it, gcb.checked)); draw(); };
      const isOpen = open.has(g.id);
      const head = h('div', { class: 'pk-g' + (n ? ' on' : '') },
        gcb,
        h('button', { class: 'pk-t', 'aria-expanded': single ? null : String(isOpen), onclick: () => { if (single) { gcb.click(); return; } isOpen ? open.delete(g.id) : open.add(g.id); draw(); } },
          !single ? h('i', { class: 'pk-car' + (isOpen ? ' open' : '') }) : null,
          h('b', {}, g.title), g.sub ? h('span', { class: 'pk-sub' }, g.sub) : null),
        !single ? h('span', { class: 'pk-n' }, `${n} of ${g.items.length}`) : null);
      if (!isOpen || single) return h('div', { class: 'pk-grp' }, head);
      const rows = g.items.map(it => {
        const cb = h('input', { type: 'checkbox', id: 'pk-' + it.id }); cb.checked = sel.has(it.id);
        cb.onchange = () => { setItem(g, it, cb.checked); draw(); };
        return h('label', { class: 'pk-i' + (cb.checked ? ' on' : ''), for: 'pk-' + it.id, title: it.value }, cb, h('span', { class: 'pk-l' }, it.label), h('span', { class: 'pk-v' }, it.value));
      });
      return h('div', { class: 'pk-grp open' }, head, h('div', { class: 'pk-items' }, rows));
    }));
    const items = all.filter(it => it.id !== 'sign' && !it.doc), docs = all.filter(it => it.doc);
    const ni = items.filter(it => sel.has(it.id)).length, nd = docs.filter(it => sel.has(it.id)).length;
    count.textContent = `${ni} of ${items.length} items${docs.length ? ` · ${nd} document${nd === 1 ? '' : 's'}` : ''}`;
    note.textContent = from === 'cp' ? `Same selection as the last packet for ${cp.value.trim()}` : from === 'last' ? 'Starting from your last packet’s selection' : '';
  }
  draw();
  const bulk = on => { for (const g of groups) for (const it of g.items) setItem(g, it, on); from = ''; draw(); };

  const go = async openIt => {
    const counterparty = cp.value.trim();
    const pick = g => g.items.filter(it => sel.has(it.id));
    const opts = {
      counterparty, logoH: prefs.logoH || 48,
      sections: groups.filter(g => g.kind === 'section').map(g => ({ title: g.title, rows: pick(g).map(it => [it.label, it.value]) })).filter(s => s.rows.length),
      persons: groups.filter(g => g.kind === 'person' && sel.has(g.items[0].id)).map(g => ({ name: g.title, roles: g.sub ? g.sub.split(', ') : [], rows: pick(g).filter(it => !it.name).map(it => [it.label, it.value]) })),
      docs: all.filter(it => it.doc && sel.has(it.id)).map(it => it.doc), sign: sel.has('sign'),
    };
    if (!opts.sections.length && !opts.persons.length && !opts.docs.length) { C.toast('Nothing selected.'); return; }
    // Remember the choice, for this counterparty and as the starting point next time.
    const snapshot = Object.fromEntries(all.map(it => [it.id, sel.has(it.id)]));
    prefs.last = snapshot; if (counterparty) prefs.by[cpKey(counterparty)] = { name: counterparty, sel: snapshot };
    persist();
    m.close();
    const b = C.busy('Building the packet…'); let bytes, notes;
    try { ({ bytes, notes } = await buildPacket(ent, opts)); } catch (e) { b.done(); C.toast('Couldn’t build the packet: ' + errMsg(e), 8000); return; }
    b.done();
    const name = `${safeName(ent.name)} - KYC information${counterparty ? ' - ' + safeName(counterparty) : ''}.pdf`;
    if (openIt) { C.setMode('pdf'); await C.openEntries([{ name, path: null, type: 'application/pdf', bytes }]); }
    else {
      const path = await host.pickSave(name); if (!path) return;
      try { await host.writePath(path, bytes); } catch (e) { C.toast('Couldn’t save: ' + errMsg(e), 7000); return; }
      C.toast(`Saved ${host.baseName(path.replace(/^download:/, ''))}`);
    }
    record(ent, opts);
    if (notes.length) setTimeout(() => C.toast(notes.join(' '), 7000), 3800);
  };
  const m = modal('Create KYC packet',
    h('div', { class: 'pk-top' },
      h('label', { class: 'fld', for: 'pk-cp' }, h('span', { class: 'lbl' }, 'For (counterparty)'), cp, cpList),
      h('div', { class: 'fld' }, h('span', { class: 'lbl' }, 'Logo'), logoBox)),
    h('div', { class: 'pk-bar' }, h('span', { class: 'lbl' }, 'Include'), count, h('span', { class: 'sp' }),
      h('button', { class: 'btn quiet', onclick: () => bulk(true) }, 'Select all'), h('button', { class: 'btn quiet', onclick: () => bulk(false) }, 'Select none')),
    note, list,
    h('div', { class: 'actions' },
      h('button', { class: 'btn quiet', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn', onclick: () => go(true) }, 'Open in PDF tab'),
      h('button', { class: 'btn primary', onclick: () => go(false) }, 'Save PDF…')));
  m.modal.classList.add('pk');
}
const safeName = s => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

/** A logo for the profile: at most 600 px wide, as PNG. */
async function shrink(f) {
  const url = URL.createObjectURL(new Blob([f.bytes], { type: f.type }));
  try {
    const img = new Image(); img.src = url; await img.decode();
    const sc = Math.min(1, 600 / img.width, 300 / img.height);
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.width * sc)); c.height = Math.max(1, Math.round(img.height * sc));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}

/** The packet goes into the fill record like any filled form. */
function record(ent, o) {
  const fields = [...o.sections.flatMap(s => s.rows), ...o.persons.flatMap(p => [['Name', p.name], ...p.rows])].map(([label, value]) => ({ label, key: '', value }));
  K.P.log.unshift({ at: new Date().toISOString(), entity: ent.id, counterparty: o.counterparty, file: 'KYC packet', fp: 'packet', fields, docs: o.docs.map(d => d.title) });
  if (K.P.log.length > 5000) K.P.log.length = 5000;
  persist();
}

// ---------------------------------------------------------------- layout
export async function buildPacket(ent, o) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${ent.name} – KYC information`); pdf.setProducer('Proof'); pdf.setCreator('Proof');
  const [reg, bold] = await Promise.all([host.systemFont(false), host.systemFont(true)]);
  let F, B, uni = false;
  if (reg) { pdf.registerFontkit(fontkit); F = await pdf.embedFont(reg, { subset: true }); B = bold ? await pdf.embedFont(bold, { subset: true }) : F; uni = true; }
  else { F = await pdf.embedFont(StandardFonts.Helvetica); B = await pdf.embedFont(StandardFonts.HelveticaBold); }
  // Without a Unicode font, characters outside Latin-1 can't be written; they become "?".
  const clean = t => (uni ? String(t) : String(t).replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '?'));
  const W = A4[0] - 2 * M, LABEL_W = 170;
  let page, y, cur = '';
  const newPage = () => { page = pdf.addPage(A4); y = A4[1] - M; };
  // A section that runs onto the next page carries its heading over.
  const need = hgt => { if (y - hgt < M + 24) { newPage(); y -= 4; if (cur) { text(cur.toUpperCase() + ' (CONTINUED)', M, 9.5, B); y -= 6; rule(1.2, INK); y -= 14; } } };
  const wrap = (text, font, size, width) => {
    const out = [];
    for (const par of clean(text).split('\n')) {
      let line = '';
      for (const word of par.split(/\s+/)) {
        const tryL = line ? line + ' ' + word : word;
        if (font.widthOfTextAtSize(tryL, size) <= width) { line = tryL; continue; }
        if (line) out.push(line);
        line = word;
        while (font.widthOfTextAtSize(line, size) > width && line.length > 1) { let k = line.length - 1; while (k > 1 && font.widthOfTextAtSize(line.slice(0, k), size) > width) k--; out.push(line.slice(0, k)); line = line.slice(k); }
      }
      out.push(line);
    }
    return out;
  };
  const text = (t, x, size, font = F, color = INK) => page.drawText(clean(t), { x, y, size, font, color });
  const rule = (w = 0.6, c = RULE) => page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: w, color: c });
  const heading = t => { cur = ''; need(40); y -= 18; text(t.toUpperCase(), M, 9.5, B); y -= 6; rule(1.2, INK); y -= 14; cur = t; };
  const row = (label, value) => {
    const lv = wrap(value, F, 10, W - LABEL_W - 10), ll = wrap(label, F, 8.5, LABEL_W - 12);
    const n = Math.max(lv.length, ll.length), hgt = n * 13 + 5;
    need(hgt);
    ll.forEach((l, i) => page.drawText(l, { x: M, y: y - i * 13, size: 8.5, font: F, color: GREY }));
    lv.forEach((l, i) => page.drawText(l, { x: M + LABEL_W, y: y - i * 13, size: 10, font: F, color: INK }));
    y -= hgt;
  };

  // Header: logo, title, who it's from and for.
  newPage();
  if (ent.logo) {
    try {
      const raw = Uint8Array.from(atob(ent.logo.split(',')[1]), c => c.charCodeAt(0));
      const img = ent.logo.startsWith('data:image/png') ? await pdf.embedPng(raw) : await pdf.embedJpg(raw);
      const H = Math.max(12, Math.min(150, o.logoH || 48)); const sc = Math.min(300 / img.width, H / img.height); const w = img.width * sc, hh = img.height * sc;
      page.drawImage(img, { x: M, y: y - hh, width: w, height: hh }); y -= hh + 22;
    } catch {}
  }
  y -= 18; text('KYC information', M, 20, B); y -= 22;
  for (const l of wrap(ent.name, B, 13, W)) { text(l, M, 13, B); y -= 16; }
  y -= 2; text([`Prepared ${fmtDay(todayIso())}`, o.counterparty ? `For ${o.counterparty}` : ''].filter(Boolean).join('   ·   '), M, 9, F, GREY); y -= 12;

  for (const s of o.sections) { heading(s.title); for (const [l, v] of s.rows) row(l, v); }
  if (o.persons.length) {
    heading('People');
    o.persons.forEach((p, i) => {
      need(48); if (i) { y -= 4; rule(); y -= 14; }
      text(p.name, M, 11, B); const nw = B.widthOfTextAtSize(clean(p.name), 11);
      if (p.roles.length) text(p.roles.join(', '), M + nw + 10, 8.5, F, GREY); y -= 17;
      for (const [l, v] of p.rows) row(l, v);
    });
  }
  if (o.sign) {
    cur = ''; need(150); y -= 22;
    text(`Signed for and on behalf of ${ent.name}`, M, 10, B); y -= 34;
    const line = (label, x, w) => { page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: 0.6, color: INK }); page.drawText(label, { x, y: y - 11, size: 8, font: F, color: GREY }); };
    const half = (W - 24) / 2;
    line('Name', M, half); line('Title', M + half + 24, half); y -= 46;
    line('Date', M, half); line('Signature', M + half + 24, half); y -= 20;
  }

  // Footer on the sheet's pages.
  const sheet = pdf.getPages(), N = sheet.length;
  sheet.forEach((pg, i) => {
    pg.drawText(clean(`${ent.name} · KYC information`), { x: M, y: M - 22, size: 7.5, font: F, color: GREY });
    const t = `Page ${i + 1} of ${N}`; pg.drawText(t, { x: A4[0] - M - F.widthOfTextAtSize(t, 7.5), y: M - 22, size: 7.5, font: F, color: GREY });
  });

  // Documents after the sheet.
  const notes = [];
  for (const d of o.docs) {
    let bytes; try { bytes = new Uint8Array(await V.docGet(d.id)); } catch (e) { notes.push(`${d.title}: ${errMsg(e)}`); continue; }
    try {
      if ((d.mime || '').startsWith('image/') || /\.(png|jpe?g)$/i.test(d.file || '')) {
        const img = /png$/i.test(d.mime || d.file || '') ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
        const pg = pdf.addPage(A4); const sc = Math.min((A4[0] - 2 * M) / img.width, (A4[1] - 2 * M) / img.height, 1);
        pg.drawImage(img, { x: (A4[0] - img.width * sc) / 2, y: (A4[1] - img.height * sc) / 2, width: img.width * sc, height: img.height * sc });
      } else {
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const cp = await pdf.copyPages(src, src.getPageIndices()); cp.forEach(p => pdf.addPage(p));
      }
    } catch (e) { notes.push(`${d.title} couldn’t be attached.`); }
  }
  return { bytes: await pdf.save(), notes };
}

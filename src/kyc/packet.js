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

/** What the packet can contain, read from the profile: [{id, title, rows:[[label, value]]}] plus people. */
function contents(ent) {
  const sections = [];
  for (const [g, title] of [...GROUPS, ['custom', 'Other']]) {
    const rows = [];
    for (const d of entityKeys(ent).filter(x => x.group === g)) {
      if (ADDRESS_PARTS.test(d.key)) continue;
      if (d.key === 'op_address' && ent.values.op_same?.v === 'yes') { rows.push(['Business address', 'Same as the registered address']); continue; }
      const v = show(ent, d.key); if (v) rows.push([d.key === 'reg_address' ? 'Registered address' : d.key === 'op_address' ? 'Business address' : d.label, v]);
    }
    if (rows.length) sections.push({ id: g, title, rows });
  }
  // Each person once, with every role they hold.
  const people = new Map();
  for (const r of ROLES) peopleIn(ent, r.role).forEach((p, i) => {
    if (!people.has(p)) people.set(p, { p, roles: [], key: `${r.role}.${i + 1}` });
    people.get(p).roles.push(`${r.label} ${i + 1}`);
  });
  const persons = [...people.values()].map(({ p, roles, key }) => {
    const rows = [], idRows = [];
    for (const d of personKeys(ent)) {
      if (NAME_PARTS.has(d.key)) continue;
      if (p.kind === 'company' && ['date_of_birth', 'place_of_birth', 'country_of_birth', 'nationality', 'nationality_2', 'pep', 'pep_details', ...ID_KEYS].includes(d.key)) continue;
      const v = show(ent, `${key}.${d.key}`); if (!v) continue;
      (ID_KEYS.has(d.key) ? idRows : rows).push([d.key === 'res_address' ? 'Address' : d.label, v]);
    }
    return { name: show(ent, `${key}.full_name`) || '(no name)', roles, rows, idRows };
  });
  return { sections, persons };
}

// ---------------------------------------------------------------- dialog
export async function createPacket(ent) {
  const { h, modal } = C;
  const { sections, persons } = contents(ent);
  const inc = new Map(sections.map(s => [s.id, true]));
  let incPeople = persons.length > 0, incIds = false, incSign = true;
  const docs = new Set();
  const cp = h('input', { type: 'text', id: 'pk-cp', spellcheck: 'false' });
  const logoBox = h('div', { class: 'pk-logo' });
  const drawLogo = () => logoBox.replaceChildren(
    ent.logo ? h('img', { src: ent.logo, alt: 'Logo' }) : h('span', { class: 'hint' }, 'No logo'),
    h('div', { class: 'btns' },
      h('button', { class: 'btn', onclick: pickLogo }, ent.logo ? 'Change…' : 'Add logo…'),
      ent.logo ? h('button', { class: 'btn quiet', onclick: () => { delete ent.logo; persist(); drawLogo(); } }, 'Remove') : null));
  async function pickLogo() {
    const f = await host.pickImage(); if (!f) return;
    try { ent.logo = await shrink(f); persist(); drawLogo(); } catch (e) { C.toast('Couldn’t read that image: ' + errMsg(e), 6000); }
  }
  drawLogo();
  const box = (id, label, sub, on, set) => { const cb = h('input', { type: 'checkbox', id, checked: on }); cb.onchange = () => set(cb.checked); return h('label', { class: 'opt', for: id }, cb, h('div', {}, label, sub ? h('small', {}, sub) : null)); };
  const incList = h('div', { class: 'pk-inc' },
    sections.map(s => box('pk-s-' + s.id, s.title, `${s.rows.length} item${s.rows.length > 1 ? 's' : ''}`, true, v => inc.set(s.id, v))),
    persons.length ? box('pk-people', 'People', persons.map(p => p.name).join(', '), true, v => (incPeople = v)) : null,
    persons.some(p => p.idRows.length) ? box('pk-ids', 'ID document numbers', 'Passport and ID numbers and dates', false, v => (incIds = v)) : null,
    box('pk-sign', 'Signature block', null, true, v => (incSign = v)));
  const docList = ent.docs.length ? h('div', { class: 'pk-inc' }, ent.docs.map(d => box('pk-d-' + d.id, d.title, docTypeInfo(d.type)[1], false, v => (v ? docs.add(d) : docs.delete(d))))) : h('p', { class: 'hint' }, 'None stored');
  const go = async open => {
    const opts = { counterparty: cp.value.trim(), sections: sections.filter(s => inc.get(s.id)), persons: incPeople ? persons : [], ids: incIds, sign: incSign, docs: ent.docs.filter(d => docs.has(d)) };
    m.close();
    const b = C.busy('Building the packet…'); let bytes, notes;
    try { ({ bytes, notes } = await buildPacket(ent, opts)); } catch (e) { b.done(); C.toast('Couldn’t build the packet: ' + errMsg(e), 8000); return; }
    b.done();
    const name = `${safeName(ent.name)} - KYC information${opts.counterparty ? ' - ' + safeName(opts.counterparty) : ''}.pdf`;
    if (open) { C.setMode('pdf'); await C.openEntries([{ name, path: null, type: 'application/pdf', bytes }]); }
    else {
      const path = await host.pickSave(name); if (!path) return;
      try { await host.writePath(path, bytes); } catch (e) { C.toast('Couldn’t save: ' + errMsg(e), 7000); return; }
      C.toast(`Saved ${host.baseName(path.replace(/^download:/, ''))}`);
    }
    record(ent, opts);
    if (notes.length) setTimeout(() => C.toast(notes.join(' '), 7000), 3800);
  };
  const m = modal('Create KYC packet',
    h('label', { class: 'fld', for: 'pk-cp' }, h('span', { class: 'lbl' }, 'For (counterparty)'), cp),
    h('div', { class: 'fld' }, h('span', { class: 'lbl' }, 'Logo'), logoBox),
    h('div', { class: 'fld' }, h('span', { class: 'lbl' }, 'Include'), incList),
    h('div', { class: 'fld' }, h('span', { class: 'lbl' }, 'Attach documents'), docList),
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
  const fields = [...o.sections.flatMap(s => s.rows), ...o.persons.flatMap(p => [['Name', p.name], ...p.rows, ...(o.ids ? p.idRows : [])])].map(([label, value]) => ({ label, key: '', value }));
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
      const sc = Math.min(160 / img.width, 56 / img.height, 1); const w = img.width * sc, hh = img.height * sc;
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
      text(p.roles.join(', '), M + nw + 10, 8.5, F, GREY); y -= 17;
      for (const [l, v] of [...p.rows, ...(o.ids ? p.idRows : [])]) row(l, v);
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

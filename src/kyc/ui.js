// Profile screens: unlock and setup, the profile editor, filling a form from the profile,
// attaching stored documents, and the record of what was sent to whom.

import * as host from '../host.js';
import { GROUPS, ENTITY_KEYS, PERSON_KEYS, ROLES, SPECIAL_KEYS, DOC_TYPES, docTypeInfo, entityKeys, personKeys, keyDef, keyLabel, roleInfo, newEntity, ENUM_KINDS } from './schema.js';
import { COUNTRIES } from './countries.js';
import { K, V, refreshInfo, unlockWith, createWith, lockNow, persist, flush, setValue, computed, rawValue, peopleIn, todayIso, entityById, errKind, errMsg, setSaveErrorHandler, onChange } from './vault.js';
import { pageLines, describeFields, flatLines, fingerprint } from './extract.js';
import { localFields, localLines, claudeMatch, claudeRequest, render, placeOnLine, yesNoOption } from './match.js';

let C; // context from main.js
const IDLE_MS = 15 * 60 * 1000;
let lastUse = Date.now();
const touch = () => (lastUse = Date.now());
setInterval(() => { if (K.P && Date.now() - lastUse > IDLE_MS) { lockNow().then(() => { closePanel(); C?.renderInsp(); C?.toast('Profile locked after 15 minutes without use.'); }); } }, 30000);

const fmtDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : iso || ''; };
const daysSince = iso => Math.floor((Date.now() - new Date(iso + 'T00:00:00').getTime()) / 86400000);
const LS_ENT = 'proof.kyc.entity';
function curEntity() {
  if (!K.P?.entities.length) return null;
  let id = null; try { id = localStorage.getItem(LS_ENT); } catch {}
  return entityById(id) || K.P.entities[0];
}
function setCurEntity(id) { try { localStorage.setItem(LS_ENT, id); } catch {} }

export function initKyc(ctx) {
  C = ctx;
  setSaveErrorHandler(async e => {
    if (errKind(e) === 'LOCKED') { K.P = null; closePanel(); C.renderInsp(); C.toast('The profile locked itself. Unlock it to keep going; your last change wasn’t saved.', 7000); return; }
    if (errKind(e) === 'CONFLICT') return conflict();
    C.toast('Couldn’t save the profile: ' + errMsg(e), 8000);
  });
  onChange(() => { if (C.S.itab === 'form') C.renderInsp(); });
  refreshInfo().catch(() => {});
  if (!host.isDesktop) import('./schema.js').then(schema => (window.__kyc = { K, V, setValue, flush, schema }));
}

async function conflict() {
  const { h, modal } = C;
  const m = modal('Profile changed elsewhere',
    h('p', {}, 'Someone (or Proof on another computer) saved the profile file after you opened it. Your last edit isn’t saved yet.'),
    h('p', { class: 'hint' }, 'Reload to see their version (your unsaved edit is dropped), or keep yours (their changes since you opened it are overwritten).'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: async () => { m.close(); await V.lock(); K.P = null; K.dirty = false; closePanel(); if (await ensureUnlocked()) openProfile(); } }, 'Reload theirs'),
      h('button', { class: 'btn danger', onclick: async () => { m.close(); try { K.dirty = true; await flush(true); C.toast('Saved your version.'); } catch (e) { C.toast(errMsg(e), 7000); } } }, 'Keep mine')));
}

// ---------------------------------------------------------------- unlock / setup
/** Resolves true once the profile is open. */
export async function ensureUnlocked() {
  touch();
  if (K.P) { try { await V.info().then(i => { if (!i.unlocked) K.P = null; }); } catch {} }
  if (K.P) return true;
  const info = await refreshInfo();
  return info.exists ? unlockDialog(info) : setupDialog(info);
}

function unlockDialog(info) {
  const { h, modal } = C;
  return new Promise(resolve => {
    const pw = h('input', { type: 'password', id: 'kyc-pw', autocomplete: 'current-password' });
    const msg = h('p', { class: 'msg', role: 'alert' });
    const go = h('button', { class: 'btn primary', onclick: ok }, 'Unlock');
    const m = modal('Unlock profile',
      h('p', { class: 'hint' }, info.path),
      h('label', { class: 'fld', for: 'kyc-pw' }, h('span', { class: 'lbl' }, 'Passphrase'), pw), msg,
      h('div', { class: 'actions' }, h('button', { class: 'btn quiet', onclick: () => { m.close(); resolve(false); } }, 'Cancel'), go));
    pw.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
    m.scrim.addEventListener('cancel', () => resolve(false));
    async function ok() {
      go.disabled = true; msg.textContent = '';
      try { await unlockWith(pw.value); m.close(); touch(); resolve(true); }
      catch (e) { go.disabled = false; msg.textContent = errMsg(e); pw.select(); }
    }
  });
}

function setupDialog(info) {
  const { h, modal } = C;
  return new Promise(resolve => {
    let path = null;
    const name = h('input', { type: 'text', id: 'kyc-ent', placeholder: 'Legal name of the first entity' });
    const p1 = h('input', { type: 'password', id: 'kyc-p1', autocomplete: 'new-password' }), p2 = h('input', { type: 'password', id: 'kyc-p2', autocomplete: 'new-password' });
    const where = h('p', { class: 'hint' }, info.path);
    const msg = h('p', { class: 'msg', role: 'alert' });
    const go = h('button', { class: 'btn primary', onclick: ok }, 'Create profile');
    const m = modal('Set up your profile',
      h('p', {}, 'One encrypted file holds your entities, people, documents and the record of what you sent. Only this passphrase opens it.'),
      h('label', { class: 'fld', for: 'kyc-ent' }, h('span', { class: 'lbl' }, 'First entity'), name),
      h('label', { class: 'fld', for: 'kyc-p1' }, h('span', { class: 'lbl' }, 'Passphrase (10+ characters)'), p1),
      h('label', { class: 'fld', for: 'kyc-p2' }, h('span', { class: 'lbl' }, 'Same again'), p2),
      h('p', { class: 'hint' }, 'There is no way to recover a forgotten passphrase. Store it in your password manager.'),
      h('div', { class: 'fld' }, h('span', { class: 'lbl' }, 'Saved at'), where,
        host.isDesktop ? h('div', { class: 'btns' },
          h('button', { class: 'btn quiet', onclick: async () => { const p = await host.pickSave(info.path, { name: 'Proof profile', ext: 'vault' }); if (p) { path = p; where.textContent = p; } } }, 'Choose location…'),
          h('button', { class: 'btn quiet', onclick: openExisting }, 'Open an existing profile…')) : null),
      msg, h('div', { class: 'actions' }, h('button', { class: 'btn quiet', onclick: () => { m.close(); resolve(false); } }, 'Cancel'), go));
    m.scrim.addEventListener('cancel', () => resolve(false));
    async function openExisting() {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const p = await open({ multiple: false, filters: [{ name: 'Proof profile', extensions: ['vault'] }] }); if (!p) return;
      try { await V.use(p); m.close(); resolve(await unlockDialog(await refreshInfo())); } catch (e) { msg.textContent = errMsg(e); }
    }
    async function ok() {
      msg.textContent = '';
      if (!name.value.trim()) { msg.textContent = 'Name the first entity.'; return; }
      if (p1.value.length < 10) { msg.textContent = 'Use at least 10 characters.'; return; }
      if (p1.value !== p2.value) { msg.textContent = 'The passphrases don’t match.'; return; }
      go.disabled = true; go.textContent = 'Creating…';
      try { await createWith(p1.value, name.value.trim(), path); m.close(); touch(); resolve(true); }
      catch (e) { go.disabled = false; go.textContent = 'Create profile'; msg.textContent = errMsg(e); }
    }
  });
}

// ---------------------------------------------------------------- profile panel
let panel = null, view = { sec: 'identity', person: null };
export async function openProfile(sec) {
  if (!(await ensureUnlocked())) return;
  if (sec) view.sec = sec;
  if (!panel) {
    panel = C.h('div', { class: 'kyc', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Profile' });
    document.body.append(panel);
    panel.addEventListener('pointerdown', touch); panel.addEventListener('keydown', touch);
    document.addEventListener('keydown', escPanel, true);
  }
  drawPanel();
}
function escPanel(e) { if (e.key === 'Escape' && panel && !document.querySelector('.scrim')) { e.stopPropagation(); closePanel(); } }
export function closePanel() {
  if (!panel) return; panel.remove(); panel = null; document.removeEventListener('keydown', escPanel, true);
  flush().catch(() => {}); C?.renderInsp();
}

function drawPanel() {
  if (!panel) return;
  const { h } = C; const ent = curEntity();
  if (!K.P) { closePanel(); return; }
  const top = panel.querySelector('.kc')?.scrollTop || 0;
  const entSel = h('select', { 'aria-label': 'Entity', class: 'entsel' }, K.P.entities.map(e => h('option', { value: e.id }, e.name)), h('option', { value: '+' }, 'Add an entity…'));
  if (ent) entSel.value = ent.id;
  entSel.onchange = () => { if (entSel.value === '+') return addEntity(); setCurEntity(entSel.value); view.person = null; drawPanel(); };
  const nav = [...GROUPS, ['people', 'People'], ['docs', 'Documents'], ['custom', 'Custom items'], ['log', 'Fill record'], ['forms', 'Saved forms'], ['settings', 'Settings']];
  const count = {
    people: ent ? ent.people.filter(p => !p.until || p.until > todayIso()).length : 0,
    docs: ent?.docs.length || 0, log: K.P.log.filter(l => l.entity === ent?.id).length, forms: Object.keys(K.P.mappings).length,
  };
  panel.replaceChildren(
    h('header', { class: 'kh' },
      h('h1', {}, 'Profile'), entSel,
      h('span', { class: 'sp' }),
      h('span', { class: 'kstate' }, K.dirty ? 'Saving…' : 'Saved · encrypted'),
      h('button', { class: 'tbtn', onclick: async () => { await lockNow(); closePanel(); C.toast('Profile locked.'); } }, 'Lock'),
      h('button', { class: 'tbtn', onclick: closePanel, title: 'Close (Esc)' }, 'Close')),
    h('nav', { class: 'kn' }, nav.map(([k, l]) => h('button', { 'aria-pressed': String(view.sec === k), onclick: () => { view.sec = k; view.person = null; drawPanel(); } }, h('span', {}, l), count[k] ? h('b', {}, count[k]) : null))),
    h('div', { class: 'kc' }, ent || ['settings', 'forms'].includes(view.sec) ? section(ent) : h('p', { class: 'hint' }, 'Add an entity to begin.')));
  panel.querySelector('.kc').scrollTop = top;
}
onChange(() => { const s = panel?.querySelector('.kstate'); if (s) s.textContent = K.dirty ? 'Saving…' : 'Saved · encrypted'; });

function addEntity() {
  const { h, modal } = C;
  const inp = h('input', { type: 'text', id: 'ne-name', placeholder: 'Legal name' });
  const m = modal('Add an entity', h('label', { class: 'fld', for: 'ne-name' }, h('span', { class: 'lbl' }, 'Legal name'), inp),
    h('div', { class: 'actions' }, h('button', { class: 'btn quiet', onclick: () => { m.close(); drawPanel(); } }, 'Cancel'), h('button', { class: 'btn primary', onclick: ok }, 'Add')));
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
  m.scrim.addEventListener('cancel', drawPanel);
  function ok() { if (!inp.value.trim()) return; const e = newEntity(inp.value.trim()); K.P.entities.push(e); setCurEntity(e.id); persist(); m.close(); view.sec = 'identity'; drawPanel(); }
}

function section(ent) {
  const s = view.sec;
  if (GROUPS.some(g => g[0] === s)) return groupEditor(ent, s);
  return ({ people: peopleView, docs: docsView, custom: customView, log: logView, forms: formsView, settings: settingsView })[s](ent);
}

// ---- value editors
const countryOpts = (h) => [h('option', { value: '' }, '—'), ...COUNTRIES.map(([c, , n]) => h('option', { value: c }, n))];
function editor(bag, def, ent, onSet) {
  const { h } = C; const cur = bag[def.key]?.v ?? '';
  const id = 'kv-' + def.key + '-' + Math.random().toString(36).slice(2, 7);
  let ctl;
  const set = v => { if (setValue(bag, def, v)) { meta.replaceWith(metaFor()); onSet?.(); } };
  if (def.kind === 'longtext') { ctl = h('textarea', { id, rows: '3' }); ctl.value = cur; ctl.addEventListener('change', () => set(ctl.value)); }
  else if (def.kind === 'date') { ctl = h('input', { type: 'date', id }); ctl.value = cur; ctl.addEventListener('change', () => set(ctl.value)); }
  else if (def.kind === 'country') { ctl = h('select', { id }, countryOpts(h)); ctl.value = cur; ctl.addEventListener('change', () => set(ctl.value)); }
  else if (def.kind === 'bool') { ctl = h('select', { id }, h('option', { value: '' }, '—'), h('option', { value: 'yes' }, 'Yes'), h('option', { value: 'no' }, 'No')); ctl.value = cur; ctl.addEventListener('change', () => set(ctl.value)); }
  else if (def.kind === 'choice') { ctl = h('select', { id }, h('option', { value: '' }, '—'), def.choices.map(c => h('option', { value: c }, c))); ctl.value = cur; ctl.addEventListener('change', () => set(ctl.value)); }
  else {
    ctl = h('input', { type: 'text', id, inputmode: def.kind === 'number' ? 'decimal' : null, spellcheck: 'false' }); ctl.value = cur;
    if (def.kind === 'computed') ctl.placeholder = computedPreview(bag, def, ent) || 'Built from the parts';
    ctl.addEventListener('change', () => set(ctl.value.trim()));
  }
  let meta = metaFor();
  function metaFor() {
    const v = bag[def.key];
    const hist = v?.hist || [];
    const bits = [];
    if (v?.at && v.v !== '') bits.push('Since ' + fmtDate(v.at));
    if (def.kind === 'computed' && !v?.v) bits.push('Built from the parts; type to override');
    const line = h('div', { class: 'kmeta' }, bits.join(' · '));
    if (hist.length) {
      const d = h('details', {}, h('summary', {}, `${hist.length} earlier value${hist.length > 1 ? 's' : ''}`),
        h('table', { class: 'khist' }, hist.map(x => h('tr', {}, h('td', {}, displayVal(def, x.v)), h('td', {}, `${fmtDate(x.at)} → ${fmtDate(x.until)}`)))));
      line.append(d);
    }
    return line;
  }
  return h('div', { class: 'krow' }, h('label', { class: 'lbl', for: id }, def.label), ctl, meta);
}
function computedPreview(bag, def, ent) { const tmp = { ...bag }; delete tmp[def.key]; return computed(def, tmp, ent); }
function displayVal(def, v) { if (def.kind === 'country') return COUNTRIES.find(c => c[0] === v)?.[2] || v; if (def.kind === 'date') return fmtDate(v); if (def.kind === 'bool') return v === 'yes' ? 'Yes' : v === 'no' ? 'No' : v; return v; }

function groupEditor(ent, g) {
  const { h } = C;
  const defs = entityKeys(ent).filter(d => d.group === g);
  const title = GROUPS.find(x => x[0] === g)[1];
  const wrap = h('div', { class: 'kgrid' });
  const draw = () => wrap.replaceChildren(...defs.map(d => editor(ent.values, d, ent, () => { if (d.key === 'legal_name' && ent.values.legal_name?.v) { ent.name = ent.values.legal_name.v; persist(); } if (/^(reg|op)_/.test(d.key)) draw(); })));
  draw();
  return h('section', { class: 'kblock' }, h('h2', {}, title), g === 'identity' ? h('p', { class: 'hint' }, 'Every value keeps its history: when you change something, the old value and its dates stay on record.') : null, wrap);
}

// ---- people
const PERSON_GROUPS = [
  ['Identity', ['full_name', 'first_name', 'last_name', 'position', 'date_of_birth', 'place_of_birth', 'country_of_birth', 'nationality']],
  ['Company details', ['full_name', 'reg_number', 'inc_country', 'position']],
  ['Address', ['res_street', 'res_postcode', 'res_city', 'res_country', 'res_address']],
  ['Ownership and control', ['ownership_pct', 'control']],
  ['Political exposure', ['pep', 'pep_details']],
  ['Identity document', ['id_type', 'id_number', 'id_country', 'id_issued', 'id_expiry']],
  ['Tax', ['tax_country', 'tin']],
  ['Contact', ['email', 'phone']],
];
const personName = p => (p.values.full_name?.v || [p.values.first_name?.v, p.values.last_name?.v].filter(Boolean).join(' ') || 'Unnamed');

function peopleView(ent) {
  const { h } = C;
  if (view.person) { const p = ent.people.find(x => x.id === view.person); if (p) return personEditor(ent, p); view.person = null; }
  const list = [...ent.people].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const cur = list.filter(p => !p.until || p.until > todayIso()), past = list.filter(p => p.until && p.until <= todayIso());
  const numbering = p => p.roles.map(r => `${roleInfo(r).label} ${peopleIn(ent, r).indexOf(p) + 1}`).join(' · ');
  const row = (p, i, arr) => h('div', { class: 'kperson' },
    h('button', { class: 'kpn', onclick: () => { view.person = p.id; drawPanel(); } }, h('b', {}, personName(p)), h('span', {}, p.until && p.until <= todayIso() ? `Until ${fmtDate(p.until)}` : numbering(p) || 'No role yet'), p.values.ownership_pct?.v ? h('span', {}, p.values.ownership_pct.v + '%') : null),
    !p.until ? h('div', { class: 'kord' },
      h('button', { class: 'x', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(arr, i, -1) }, '↑'),
      h('button', { class: 'x', title: 'Move down', 'aria-label': 'Move down', disabled: i === arr.length - 1, onclick: () => move(arr, i, 1) }, '↓')) : null);
  function move(arr, i, d) { const a = arr[i], b = arr[i + d]; arr.forEach((p, k) => (p.order = k)); [a.order, b.order] = [b.order, a.order]; persist(); drawPanel(); }
  const add = kind => { const p = { id: crypto.randomUUID(), kind, roles: [], values: {}, order: ent.people.length, since: todayIso() }; ent.people.push(p); persist(); view.person = p.id; drawPanel(); };
  return h('section', { class: 'kblock' }, h('h2', {}, 'People'),
    h('p', { class: 'hint' }, 'Directors, owners, signatories and members, people or companies. The order here is the numbering forms use: the first UBO listed is “UBO 1”.'),
    h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => add('person') }, 'Add a person'), h('button', { class: 'btn', onclick: () => add('company') }, 'Add a company')),
    h('div', { class: 'kplist' }, cur.length ? cur.map(row) : h('p', { class: 'hint' }, 'Nobody yet.')),
    past.length ? h('details', { class: 'kpast' }, h('summary', {}, `${past.length} no longer involved`), h('div', { class: 'kplist' }, past.map(row))) : null);
}

function personEditor(ent, p) {
  const { h } = C;
  const roles = h('div', { class: 'kroles' }, ROLES.map(r => {
    const id = 'role-' + r.role; const cb = h('input', { type: 'checkbox', id, checked: p.roles.includes(r.role) });
    cb.onchange = () => { p.roles = cb.checked ? [...p.roles, r.role] : p.roles.filter(x => x !== r.role); persist(); };
    return h('label', { class: 'chk', for: id }, cb, r.label);
  }));
  const groups = PERSON_GROUPS.filter(([t]) => p.kind === 'company' ? !['Identity', 'Political exposure', 'Identity document'].includes(t) : t !== 'Company details');
  const defs = personKeys(ent);
  const custom = defs.filter(d => !PERSON_KEYS.includes(d));
  const blocks = groups.map(([t, keys]) => h('div', { class: 'kblock2' }, h('h3', {}, t), h('div', { class: 'kgrid' }, keys.map(k => editor(p.values, defs.find(d => d.key === k), ent)))));
  if (custom.length) blocks.push(h('div', { class: 'kblock2' }, h('h3', {}, 'Custom'), h('div', { class: 'kgrid' }, custom.map(d => editor(p.values, d, ent)))));
  const until = h('input', { type: 'date', id: 'p-until' }); until.value = p.until || '';
  until.onchange = () => { p.until = until.value || undefined; persist(); };
  return h('section', { class: 'kblock' },
    h('div', { class: 'btns' }, h('button', { class: 'btn quiet', onclick: () => { view.person = null; drawPanel(); } }, '← People')),
    h('h2', {}, personName(p)),
    h('div', { class: 'kblock2' }, h('h3', {}, 'Roles'), roles),
    ...blocks,
    h('div', { class: 'kblock2' }, h('h3', {}, 'Leaving'),
      h('p', { class: 'hint' }, 'When someone stops being involved, set the date instead of deleting them. Forms stop using them from that day, and the record stays.'),
      h('label', { class: 'fld', for: 'p-until' }, h('span', { class: 'lbl' }, 'Involved until'), until),
      h('div', { class: 'btns' }, h('button', { class: 'btn danger', onclick: () => confirmDo(`Delete ${personName(p)} permanently?`, 'Their values and history go too. The record of what you sent keeps what was sent.', 'Delete', () => { ent.people = ent.people.filter(x => x !== p); persist(); view.person = null; drawPanel(); }) }, 'Delete permanently'))));
}

function confirmDo(title, text, label, fn) {
  const { h, modal } = C;
  const m = modal(title, h('p', {}, text), h('div', { class: 'actions' }, h('button', { class: 'btn quiet', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn danger', onclick: () => { m.close(); fn(); } }, label)));
}

// ---- documents
const mimeOf = n => /\.png$/i.test(n) ? 'image/png' : /\.jpe?g$/i.test(n) ? 'image/jpeg' : 'application/pdf';
function ageNote(d) {
  const max = docTypeInfo(d.type)[2];
  if (d.expires && d.expires < todayIso()) return { bad: true, text: `Expired ${fmtDate(d.expires)}` };
  if (d.issued && max && daysSince(d.issued) > max) return { bad: true, text: `Issued ${daysSince(d.issued)} days ago; counterparties usually want one under ${Math.round(max / 30)} months old` };
  if (d.issued) return { text: `Issued ${daysSince(d.issued)} days ago` };
  return { text: 'Issue date not set' };
}
async function addDocs(ent, owner = '') {
  const files = await host.pickOpen({ title: 'Add documents to the profile' }); if (!files.length) return;
  const b = C.busy('Encrypting…');
  try {
    for (const f of files) {
      const id = crypto.randomUUID(); await V.docPut(id, f.bytes);
      ent.docs.push({ id, type: 'other', title: f.name.replace(/\.(pdf|png|jpe?g)$/i, ''), file: f.name, mime: f.type || mimeOf(f.name), size: f.bytes.length, issued: '', expires: '', owner, added: todayIso() });
    }
    persist();
  } catch (e) { C.toast('Couldn’t store the document: ' + errMsg(e), 7000); }
  finally { b.done(); }
  drawPanel();
}
async function docEntry(d) { const bytes = await V.docGet(d.id); return { name: d.file || d.title + '.pdf', path: null, type: d.mime || 'application/pdf', bytes }; }

function docsView(ent) {
  const { h } = C;
  const rows = ent.docs.map(d => {
    const type = h('select', { 'aria-label': 'Type' }, DOC_TYPES.map(([k, l]) => h('option', { value: k }, l))); type.value = d.type;
    const title = h('input', { type: 'text', 'aria-label': 'Title', value: d.title });
    const issued = h('input', { type: 'date', 'aria-label': 'Issued' }); issued.value = d.issued || '';
    const expires = h('input', { type: 'date', 'aria-label': 'Expires' }); expires.value = d.expires || '';
    const owner = h('select', { 'aria-label': 'About' }, h('option', { value: '' }, 'The entity'), ent.people.map(p => h('option', { value: p.id }, personName(p)))); owner.value = d.owner || '';
    const note = ageNote(d);
    const upd = () => { d.type = type.value; d.title = title.value; d.issued = issued.value; d.expires = expires.value; d.owner = owner.value; persist(); drawPanel(); };
    [type, issued, expires, owner].forEach(x => x.addEventListener('change', upd)); title.addEventListener('change', upd);
    return h('div', { class: 'kdoc' + (note.bad ? ' bad' : '') },
      h('div', { class: 'kdg' }, h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Type'), type), h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Title'), title)),
      h('div', { class: 'kdg3' }, h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Issued'), issued), h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Expires'), expires), h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'About'), owner)),
      h('div', { class: 'kdf' }, h('span', { class: 'kmeta' }, `${d.file} · ${Math.max(1, Math.round(d.size / 1024))} KB · ${note.text}`), h('span', { class: 'sp' }),
        h('button', { class: 'btn quiet', onclick: async () => { try { const e = await docEntry(d); closePanel(); C.S.pages.length ? C.insertEntries([e]) : C.openEntries([e]); } catch (er) { C.toast(errMsg(er), 6000); } } }, C.S.pages.length ? 'Insert into document' : 'Open'),
        h('button', { class: 'btn quiet', onclick: async () => { const p = await host.pickSave(d.file || d.title + '.pdf', { name: 'Document', ext: (d.file || '.pdf').split('.').pop() }); if (!p) return; try { await host.writePath(p, (await docEntry(d)).bytes); C.toast('Saved an unencrypted copy.'); } catch (er) { C.toast(errMsg(er), 6000); } } }, 'Save a copy…'),
        h('button', { class: 'btn quiet', onclick: async () => { const f = await host.pickOpen({ multiple: false }); if (!f.length) return; try { await V.docPut(d.id, f[0].bytes); d.file = f[0].name; d.mime = f[0].type; d.size = f[0].bytes.length; d.issued = ''; persist(); drawPanel(); C.toast('Replaced. Set the new issue date.'); } catch (er) { C.toast(errMsg(er), 6000); } } }, 'Replace…'),
        h('button', { class: 'btn quiet danger', onclick: () => confirmDo('Delete this document?', `${d.title} is removed from the profile.`, 'Delete', async () => { try { await V.docDelete(d.id); } catch {} ent.docs = ent.docs.filter(x => x !== d); persist(); drawPanel(); }) }, 'Delete')));
  });
  return h('section', { class: 'kblock' }, h('h2', {}, 'Documents'),
    h('p', { class: 'hint' }, 'Stored encrypted next to the profile. Set issue dates so Proof can warn when an extract is too old to send.'),
    h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => addDocs(ent) }, 'Add documents…')),
    rows.length ? h('div', { class: 'kdocs' }, rows) : h('p', { class: 'hint' }, 'None yet.'));
}

// ---- custom items
function customView(ent) {
  const { h } = C;
  const label = h('input', { type: 'text', id: 'cu-l', placeholder: 'e.g. DNB relation number' });
  const kind = h('select', { id: 'cu-k' }, [['text', 'Text'], ['longtext', 'Long text'], ['date', 'Date'], ['country', 'Country'], ['bool', 'Yes / no'], ['number', 'Number']].map(([k, l]) => h('option', { value: k }, l)));
  const scope = h('select', { id: 'cu-s' }, h('option', { value: 'e' }, 'The entity'), h('option', { value: 'p' }, 'Each person'));
  const aliases = h('input', { type: 'text', id: 'cu-a', placeholder: 'Other wordings forms use, separated by commas' });
  const add = () => {
    if (!label.value.trim()) return;
    const slug = label.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'item';
    ent.custom.push({ key: `x_${slug}_${Math.random().toString(36).slice(2, 6)}`, label: label.value.trim(), kind: kind.value, person: scope.value === 'p', aliases: [label.value.trim(), ...aliases.value.split(',').map(s => s.trim()).filter(Boolean)] });
    persist(); drawPanel();
  };
  const list = ent.custom.map(c => h('div', { class: 'file' }, h('span', { class: 'nm' }, c.label), h('span', { class: 'pp' }, `${c.person ? 'person' : 'entity'} · ${c.kind}`),
    h('button', { class: 'x', 'aria-label': 'Remove ' + c.label, onclick: () => confirmDo(`Remove “${c.label}”?`, 'Its stored values stay in the file but are no longer shown or used.', 'Remove', () => { ent.custom = ent.custom.filter(x => x !== c); persist(); drawPanel(); }) }, '×')));
  const vals = ent.custom.filter(c => !c.person).map(c => editor(ent.values, { ...c }, ent));
  return h('section', { class: 'kblock' }, h('h2', {}, 'Custom items'),
    h('p', { class: 'hint' }, 'Anything forms keep asking for that isn’t on the standard list. Entity items are filled in below; person items appear on each person.'),
    h('div', { class: 'kgrid' }, h('label', { class: 'fld', for: 'cu-l' }, h('span', { class: 'lbl' }, 'Name'), label), h('label', { class: 'fld', for: 'cu-k' }, h('span', { class: 'lbl' }, 'Kind'), kind),
      h('label', { class: 'fld', for: 'cu-s' }, h('span', { class: 'lbl' }, 'Belongs to'), scope), h('label', { class: 'fld', for: 'cu-a' }, h('span', { class: 'lbl' }, 'Also called'), aliases)),
    h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: add }, 'Add item')),
    list.length ? h('div', {}, list) : null,
    vals.length ? h('div', { class: 'kblock2' }, h('h3', {}, 'Values'), h('div', { class: 'kgrid' }, vals)) : null);
}

// ---- record of what was sent
function logView(ent) {
  const { h } = C;
  const q = h('input', { type: 'text', placeholder: 'Search counterparty, form or value', 'aria-label': 'Search' });
  const list = h('div', { class: 'klog' });
  const draw = () => {
    const t = q.value.toLowerCase().trim();
    const rows = K.P.log.filter(l => l.entity === ent.id && (!t || [l.counterparty, l.file, ...l.fields.map(f => f.value + ' ' + f.label)].join(' ').toLowerCase().includes(t)));
    list.replaceChildren(...(rows.length ? rows.map(l => h('details', {},
      h('summary', {}, h('b', {}, l.counterparty || 'Unnamed counterparty'), h('span', {}, `${fmtDate(l.at.slice(0, 10))} · ${l.file} · ${l.fields.length} answers`)),
      h('table', { class: 'ktab' }, h('tr', {}, h('th', {}, 'Field'), h('th', {}, 'Item'), h('th', {}, 'Value')), l.fields.map(f => h('tr', {}, h('td', {}, f.label), h('td', {}, keyLabel(ent, f.key) || f.key), h('td', {}, String(f.value))))),
      h('div', { class: 'btns' }, h('button', { class: 'btn quiet danger', onclick: () => confirmDo('Delete this record?', 'It can’t be brought back.', 'Delete', () => { K.P.log = K.P.log.filter(x => x !== l); persist(); draw(); }) }, 'Delete record'))))
      : [h('p', { class: 'hint' }, t ? 'Nothing matches.' : 'Nothing yet. Each time you fill a form from the profile, what went into it is recorded here.')]));
  };
  q.addEventListener('input', draw); draw();
  return h('section', { class: 'kblock' }, h('h2', {}, 'Fill record'), h('p', { class: 'hint' }, 'Every form you filled from the profile, with the values as they were at the time. Useful when someone asks what you told them last year.'), q, list);
}

function formsView() {
  const { h } = C;
  const ms = Object.entries(K.P.mappings).sort((a, b) => (b[1].updated || '').localeCompare(a[1].updated || ''));
  return h('section', { class: 'kblock' }, h('h2', {}, 'Saved forms'),
    h('p', { class: 'hint' }, 'Forms Proof recognises. When the same form comes back, your reviewed answers are reused. Forget one to make Proof match it fresh.'),
    ms.length ? h('div', {}, ms.map(([fp, m]) => h('div', { class: 'file' }, h('span', { class: 'nm', title: m.title }, m.title), h('span', { class: 'pp' }, `${m.kind === 'flat' ? 'flat' : 'fillable'} · ${m.kind === 'flat' ? m.entries.length : Object.keys(m.entries).length} answers · ${fmtDate(m.updated)}`),
      h('button', { class: 'x', 'aria-label': 'Forget ' + m.title, onclick: () => { delete K.P.mappings[fp]; persist(); drawPanel(); } }, '×')))) : h('p', { class: 'hint' }, 'None yet.'));
}

function settingsView() {
  const { h } = C; const st = K.P.settings;
  const info = K.info || {};
  const key = h('input', { type: 'password', id: 'st-key', autocomplete: 'off', placeholder: info.has_key ? 'A key is stored' : 'sk-ant-…' });
  const model = h('select', { id: 'st-model' }, [['claude-sonnet-5-5', 'Claude Sonnet 5.5 (default)'], ['claude-opus-5-5', 'Claude Opus 5.5 (most careful, slower)'], ['claude-haiku-5-5', 'Claude Haiku 5.5 (fastest)']].map(([v, l]) => h('option', { value: v }, l))); model.value = st.model;
  model.onchange = () => { st.model = model.value; persist(); };
  const use = h('input', { type: 'checkbox', id: 'st-use', checked: st.useClaude !== false }); use.onchange = () => { st.useClaude = use.checked; persist(); };
  const df = h('select', { id: 'st-df' }, ['DD-MM-YYYY', 'DD/MM/YYYY', 'DD.MM.YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY', 'D MMMM YYYY'].map(f => h('option', { value: f }, f))); df.value = st.dateFormat; df.onchange = () => { st.dateFormat = df.value; persist(); };
  const old = h('input', { type: 'password', id: 'st-old', autocomplete: 'current-password' }), n1 = h('input', { type: 'password', id: 'st-n1', autocomplete: 'new-password' }), n2 = h('input', { type: 'password', id: 'st-n2', autocomplete: 'new-password' });
  const pmsg = h('p', { class: 'msg', role: 'alert' });
  return h('section', { class: 'kblock' }, h('h2', {}, 'Settings'),
    h('div', { class: 'kblock2' }, h('h3', {}, 'Matching with Claude'),
      h('p', { class: 'hint' }, 'Proof first matches fields itself, on this computer. Claude does the rest: it receives the form’s own text (field names, printed labels, options) and the names of your profile items, never their values. Before anything is sent, Proof checks every word against the values in this profile and cuts out any match. Only the Rust side of the app can reach the network; the screen you are looking at can’t.'),
      h('label', { class: 'opt', for: 'st-use' }, use, h('div', {}, 'Offer Claude matching', h('small', {}, 'Off: matching stays local and you map the rest by hand.'))),
      h('label', { class: 'fld', for: 'st-key' }, h('span', { class: 'lbl' }, 'Anthropic API key'), key),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: async () => { if (!key.value.trim()) return; try { await V.setKey(key.value.trim()); key.value = ''; await refreshInfo(); C.toast('Key stored in Windows Credential Manager.'); drawPanel(); } catch (e) { C.toast(errMsg(e), 7000); } } }, 'Store key'),
        info.has_key ? h('button', { class: 'btn quiet danger', onclick: async () => { await V.setKey(''); await refreshInfo(); drawPanel(); } }, 'Remove key') : null),
      h('p', { class: 'hint' }, 'The key lives in Windows Credential Manager, not in the profile, and never reaches this screen.'),
      h('label', { class: 'fld', for: 'st-model' }, h('span', { class: 'lbl' }, 'Model'), model)),
    h('div', { class: 'kblock2' }, h('h3', {}, 'Answers'), h('label', { class: 'fld', for: 'st-df' }, h('span', { class: 'lbl' }, 'Default date format'), df), h('p', { class: 'hint' }, 'Used when a form doesn’t say which format it wants.')),
    h('div', { class: 'kblock2' }, h('h3', {}, 'Profile file'),
      h('p', { class: 'hint' }, info.path || ''),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: async () => { const d = await host.pickFolder('Choose a folder for the backup'); if (!d || d.startsWith('download:')) return; try { const n = await V.backup(d); C.toast(`Backed up the profile and ${n} document${n === '1' ? '' : 's'}, still encrypted.`); } catch (e) { C.toast(errMsg(e), 7000); } } }, 'Back up…'),
        host.isDesktop ? h('button', { class: 'btn', onclick: async () => {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const p = await open({ multiple: false, filters: [{ name: 'Proof profile', extensions: ['vault'] }] }); if (!p) return;
          await flush().catch(() => {}); await V.use(p); K.P = null; closePanel(); if (await ensureUnlocked()) openProfile('identity');
        } }, 'Open a different profile…') : null),
      h('p', { class: 'hint' }, 'A profile in a shared folder works for a team: Proof notices when someone else saved in the meantime and asks before overwriting. It locks after 15 minutes without use.')),
    h('div', { class: 'kblock2' }, h('h3', {}, 'Change passphrase'),
      h('div', { class: 'kgrid' }, h('label', { class: 'fld', for: 'st-old' }, h('span', { class: 'lbl' }, 'Current'), old), h('label', { class: 'fld', for: 'st-n1' }, h('span', { class: 'lbl' }, 'New'), n1), h('label', { class: 'fld', for: 'st-n2' }, h('span', { class: 'lbl' }, 'New again'), n2)), pmsg,
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: async () => {
        pmsg.textContent = '';
        if (n1.value !== n2.value) { pmsg.textContent = 'The new passphrases don’t match.'; return; }
        const b = C.busy('Re-encrypting…');
        try { await flush(); await V.passphrase(old.value, n1.value); b.done(); old.value = n1.value = n2.value = ''; C.toast('Passphrase changed.'); } catch (e) { b.done(); pmsg.textContent = errMsg(e); }
      } }, 'Change passphrase'))));
}

// ---------------------------------------------------------------- Form tab: fill from profile
export function formSection(body, docs) {
  const { h, sec } = C;
  const info = K.info;
  if (!K.P) {
    body.append(sec('Fill from profile',
      h('p', { class: 'hint' }, info?.exists ? 'Your KYC profile is locked.' : 'Keep your KYC answers in one encrypted profile and fill counterparty forms from it.'),
      h('div', { class: 'btns' }, h('button', { class: 'btn primary', onclick: async () => { if (await ensureUnlocked()) C.renderInsp(); } }, info?.exists ? 'Unlock profile' : 'Set up profile'))));
    return;
  }
  const ent = curEntity();
  const sel = h('select', { 'aria-label': 'Entity' }, K.P.entities.map(e => h('option', { value: e.id }, e.name))); if (ent) sel.value = ent.id;
  sel.onchange = () => { setCurEntity(sel.value); C.renderInsp(); };
  const target = docs.find(d => d.fields.length) || docs[0];
  body.append(sec('Fill from profile',
    K.P.entities.length > 1 ? h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Entity'), sel) : h('p', { class: 'hint' }, `As ${ent?.name || '—'}`),
    docs.length > 1 ? h('p', { class: 'hint' }, `Works on ${target.name}.`) : null,
    h('div', { class: 'btns' },
      h('button', { class: 'btn primary', disabled: !ent || !target, onclick: () => startFill(target) }, target?.fields.length ? 'Match fields…' : 'Find answer spots…'),
      h('button', { class: 'btn', disabled: !ent, onclick: attachDocs }, 'Attach documents…'),
      h('button', { class: 'btn quiet', onclick: () => openProfile() }, 'Profile'))));
}

async function startFill(doc) {
  if (!(await ensureUnlocked())) return;
  const ent = curEntity(); if (!ent) return;
  const b = C.busy('Reading the form…');
  let lines, fields, fp;
  try {
    lines = await pageLines(doc);
    fields = doc.fields.length ? await describeFields(doc, lines) : [];
    fp = await fingerprint(doc, fields, lines);
  } catch (e) { b.done(); C.toast('Couldn’t read the form: ' + (e?.message || e), 7000); return; }
  b.done();
  const flat = !fields.length;
  const fl = flat ? flatLines(lines) : null;
  if (flat && !fl.length) { C.toast('This form has no fillable fields and no text Proof can read (it may be a scan). Use the Text tool, or run it through OCR first.', 8000); return; }
  const saved = K.P.mappings[fp];
  await refreshInfo().catch(() => {});
  review({ doc, ent, fields, lines: fl, flat, fp, saved });
}

// ---- review
function review(R) {
  const { h, modal } = C; const { ent, flat } = R;
  // Rows: one per field (fillable) or one per proposal (flat).
  const rows = [];
  const byId = new Map((flat ? R.lines : R.fields).map(x => [x.id, x]));
  const optKeys = keyOptions(ent);
  const mkRow = (target, p) => {
    const r = { target, key: p?.key || null, as: p?.as || '', confidence: p?.confidence || null, note: p?.note || '', source: p?.source || null, place: p?.place, option: p?.option, label: p?.label, pos: p?.pos || null, include: false, touched: false };
    r.include = defaultInclude(r); rows.push(r); return r;
  };
  const props = () => {
    if (R.saved) {
      if (!flat) for (const f of R.fields) { const e = R.saved.entries[f.name]; if (e && !e.skip) mkRow(f, { ...e, confidence: 'saved', source: 'saved' }); }
      else for (const e of R.saved.entries) mkRow({ id: 'S' + rows.length, page: e.page, text: e.lineText || '', saved: true }, { key: e.key, as: e.as, confidence: 'saved', source: 'saved', pos: { x: e.x, y: e.y, size: e.size } });
    }
    const have = new Set(rows.map(r => r.target.id));
    const local = flat ? localLines(ent, R.lines) : localFields(ent, R.fields.filter(f => !R.saved || !(f.name in R.saved.entries)));
    for (const p of local) if (flat || !have.has(p.id)) mkRow(byId.get(p.id), p);
    if (!flat) for (const f of R.fields) if (!f.ro && !rows.some(r => r.target === f) && !(R.saved?.entries[f.name]?.skip)) mkRow(f, null);
  };
  props();
  let filter = 'all', running = false;
  const datalist = h('datalist', { id: 'kyc-keys' }, optKeys.map(([lab]) => h('option', { value: lab })));
  const labelToKey = new Map(optKeys);
  const tbody = h('div', { class: 'rv-rows' });
  const counts = h('span', { class: 'rv-count' });
  const cp = h('input', { type: 'text', id: 'rv-cp', placeholder: 'e.g. ABN AMRO Clearing' });
  cp.value = guessCounterparty(R.doc);
  const applyBtn = h('button', { class: 'btn primary', onclick: apply }, 'Apply');
  const info = K.info || {};
  const canClaude = K.P.settings.useClaude !== false;
  const cBtn = h('button', { class: 'btn', disabled: !info.has_key || !canClaude, onclick: runClaude, title: info.has_key ? '' : 'Add an API key under Profile → Settings' }, 'Match the rest with Claude');
  const seg = h('div', { class: 'seg' });
  const drawSeg = () => seg.replaceChildren(...[['all', 'All'], ['attn', 'Needs a look'], ['none', 'Unmatched']].map(([k, l]) => h('button', { 'aria-pressed': String(filter === k), onclick: () => { filter = k; drawSeg(); draw(); } }, l)));
  drawSeg();
  const m = modal('Fill from profile',
    h('p', { class: 'hint' }, `${ent.name} → ${R.doc.name}${R.saved ? ` · recognised from ${fmtDate(R.saved.updated)}` : ''}${flat ? ' · no fillable fields: answers are typed onto the page, and you can drag them into place afterwards' : ''}`),
    h('div', { class: 'rv-bar' }, canClaude ? cBtn : null, canClaude ? h('button', { class: 'btn quiet', onclick: showSent }, 'What gets sent?') : null, h('span', { class: 'sp' }), seg),
    h('div', { class: 'rv-head' }, h('span', {}, ''), h('span', {}, flat ? 'Line on the form' : 'Field'), h('span', {}, 'Profile item'), h('span', {}, 'Answer'), h('span', {}, '')),
    tbody, datalist,
    h('div', { class: 'rv-foot' }, h('label', { class: 'fld', for: 'rv-cp' }, h('span', { class: 'lbl' }, 'Sent to (for the record)'), cp), counts),
    h('div', { class: 'actions' }, h('button', { class: 'btn quiet', onclick: () => m.close() }, 'Cancel'), applyBtn));
  m.modal.classList.add('wide');

  function attention(r) {
    const res = r.key ? render(ent, r.key, r.as, fieldOf(r)) : null;
    return !r.key || r.confidence === 'low' || r.confidence === 'medium' || r.note || res?.missing || res?.problem || ['check', 'radio', 'select'].includes(fieldOf(r).kind) || keyDef(ent, r.key)?.kind === 'longtext';
  }
  function fieldOf(r) { return flat ? { kind: r.place === 'mark' ? 'check' : 'text' } : r.target; }
  function defaultInclude(r) {
    if (!r.key) return false;
    const res = render(ent, r.key, r.as, fieldOf(r));
    if (res.missing || res.problem) return false;
    if (r.confidence === 'saved') return true;
    return r.confidence === 'high' && (flat ? r.place !== 'mark' : r.target.kind === 'text') && keyDef(ent, r.key)?.kind !== 'longtext' && !r.note;
  }
  function draw() {
    const vis = rows.filter(r => filter === 'all' || (filter === 'attn' ? r.key && attention(r) : !r.key));
    tbody.replaceChildren(...(vis.length ? vis.map(rowEl) : [h('p', { class: 'hint' }, 'Nothing here.')]));
    const n = rows.filter(r => r.include && r.key).length;
    counts.textContent = `${rows.filter(r => r.key).length} of ${rows.length} matched · ${n} will be filled`;
    applyBtn.textContent = n ? `Fill ${n}` : 'Fill'; applyBtn.disabled = !n;
  }
  function rowEl(r) {
    const f = r.target; const res = r.key ? render(ent, r.key, r.as, fieldOf(r)) : null;
    const inc = h('input', { type: 'checkbox', 'aria-label': 'Fill this', checked: r.include, disabled: !r.key || res?.missing });
    inc.onchange = () => { r.include = inc.checked; draw(); };
    const item = h('input', { type: 'text', list: 'kyc-keys', 'aria-label': 'Profile item', placeholder: '— leave empty', spellcheck: 'false' });
    item.value = r.key ? keyLabel(ent, r.key) : '';
    item.addEventListener('change', () => {
      const v = item.value.trim();
      const k = !v ? null : labelToKey.get(v) || (keyDef(ent, v) ? v : undefined);
      if (k === undefined) { item.classList.add('bad'); return; }
      r.key = k; r.touched = true; r.confidence = 'you'; r.note = '';
      if (k) r.as = defaultAs(ent, k, fieldOf(r), r.as);
      r.include = !!k && !render(ent, k, r.as, fieldOf(r)).missing; draw();
    });
    const as = h('input', { type: 'text', class: 'rv-as', 'aria-label': 'How to write it', value: r.as, title: 'How the value is written: text, date:DD-MM-YYYY, country:iso2, check, check:!yes, select, upper, literal:N/A', spellcheck: 'false' });
    as.addEventListener('change', () => { r.as = as.value.trim(); r.touched = true; draw(); });
    const fieldCell = flat
      ? h('div', { class: 'rv-f' }, h('b', {}, f.text || '(saved position)'), h('small', {}, `p${f.page}${r.place ? ' · answer ' + ({ right: 'to the right', below: 'below', mark: r.option === '@yesno' ? 'as a tick on yes or no' : 'as a tick on “' + (r.option || '') + '”' })[r.place] : ''}`))
      : h('div', { class: 'rv-f' }, h('b', {}, fieldLabel(f)), h('small', {}, `p${f.page} · ${f.kind}${f.section ? ' · ' + f.section : ''} · ${f.name}`));
    const ans = !r.key ? h('span', { class: 'rv-none' }, 'Not filled')
      : res.missing ? h('span', { class: 'rv-miss' }, 'Not in the profile')
      : h('span', { class: 'rv-ans' + (res.problem ? ' warn' : '') }, res.show, res.problem ? h('small', {}, res.problem) : null);
    const conf = r.confidence ? h('span', { class: 'chip c-' + r.confidence, title: r.source === 'claude' ? 'Matched by Claude' : r.source === 'local' ? 'Matched on this computer' : '' }, r.confidence === 'you' ? 'yours' : r.confidence) : h('span', {});
    return h('div', { class: 'rv-row' + (r.include ? ' on' : '') }, inc, fieldCell, h('div', { class: 'rv-k' }, item, as), h('div', {}, ans, r.note ? h('div', { class: 'rv-note' }, r.note) : null), conf);
  }
  async function runClaude() {
    if (running) return; running = true; cBtn.disabled = true; cBtn.textContent = 'Asking Claude…';
    try {
      // Only what's still open: fields without a saved or hand-made answer.
      const open = flat ? R.lines : R.fields.filter(f => !f.ro && !rows.some(r => r.target === f && (r.source === 'saved' || r.touched)));
      const { matches, removed } = await claudeMatch(ent, flat ? { lines: open, title: R.doc.name } : { fields: open, title: R.doc.name }, (i, n) => (cBtn.textContent = n > 1 ? `Asking Claude… ${i}/${n}` : 'Asking Claude…'));
      let changed = 0;
      for (const p of matches) {
        if (flat) {
          if (!p.key) continue;
          if (p.place === 'mark') { const i = rows.findIndex(r => r.target.id === p.id && r.key === p.key && r.option === '@yesno'); if (i >= 0) rows.splice(i, 1); }
          const dup = rows.find(r => r.target.id === p.id && r.key === p.key && (r.option || '') === (p.option || ''));
          if (dup && dup.source !== 'saved') { Object.assign(dup, { as: p.as || dup.as, confidence: p.confidence, note: p.note, place: p.place || dup.place, option: p.option, label: p.label || dup.label, source: 'claude' }); dup.include = defaultInclude(dup); changed++; continue; }
          if (!dup) { mkRow(byId.get(p.id), p); changed++; }
          continue;
        }
        const r = rows.find(r => r.target.id === p.id);
        if (!r || r.touched || r.source === 'saved') continue;
        // Claude decides for fields the local matcher left open, and overrides weak local guesses.
        if (r.key && r.confidence === 'high' && r.source === 'local' && p.key !== r.key && p.confidence !== 'high') continue;
        Object.assign(r, { key: p.key, as: p.key ? (p.as || defaultAs(ent, p.key, r.target, '')) : '', confidence: p.confidence, note: p.note, source: 'claude' });
        r.include = defaultInclude(r); changed++;
      }
      if (flat) rows.sort((a, b) => (a.target.page - b.target.page) || (b.target.y ?? 0) - (a.target.y ?? 0));
      C.toast(`Claude matched ${changed} item${changed === 1 ? '' : 's'}.${removed ? ` ${removed} bit${removed > 1 ? 's' : ''} of form text matching your profile ${removed > 1 ? 'were' : 'was'} cut before sending.` : ''}`, 6000);
      draw();
    } catch (e) {
      C.toast(errKind(e) === 'NOKEY' ? errMsg(e) : 'Claude matching failed: ' + errMsg(e), 8000);
    } finally { running = false; cBtn.disabled = false; cBtn.textContent = 'Match the rest with Claude'; }
  }
  async function showSent() {
    const open = flat ? R.lines : R.fields.filter(f => !f.ro).slice(0, 140);
    try {
      const [text, removed] = await V.preview(claudeRequest(ent, flat ? { lines: open.slice(0, 260), title: R.doc.name } : { fields: open, title: R.doc.name }));
      const pre = h('pre', { class: 'rv-pre' }); pre.textContent = text;
      const mm = modal('What gets sent', h('p', { class: 'hint' }, `This is the exact request text${(flat ? R.lines.length > 260 : R.fields.length > 140) ? ' (first part; large forms go in several requests)' : ''}. ${removed ? `${removed} bit${removed > 1 ? 's' : ''} matching your profile ${removed > 1 ? 'were' : 'was'} replaced with […].` : 'Nothing in it matched a value in your profile.'}`), pre,
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => mm.close() }, 'Close')));
      mm.modal.classList.add('wide');
    } catch (e) { C.toast(errMsg(e), 6000); }
  }
  async function apply() {
    const use = rows.filter(r => r.include && r.key);
    const fields = []; let n = 0; const errs = [];
    C.commit();
    if (!flat) {
      const d = R.doc;
      for (const r of use) {
        const res = render(ent, r.key, r.as, r.target);
        if (res.missing || (res.problem && !res.value && res.value !== false)) { errs.push(r.target.name); continue; }
        d.values[r.target.name] = res.value; n++;
        fields.push(logField(fieldLabel(r.target), r.key, res.show));
      }
    } else {
      const items = [];
      for (const r of use) {
        const res = render(ent, r.key, r.as, fieldOf(r)); if (res.missing) continue;
        const isMark = r.place === 'mark';
        const opt = isMark && r.option === '@yesno' ? yesNoOption(r.target, rawValue(ent, r.key)) : r.option;
        if (isMark && !r.pos && !opt) continue;
        const pos = r.pos || placeOnLine(r.target, { ...r, option: opt }, null);
        if (isMark && !res.value) continue;
        const text = isMark ? 'X' : wrap(res.show, pos, R.doc, r.target.page - 1);
        items.push({ page: r.target.page - 1, x: pos.x, y: pos.y, size: pos.size, text, r });
        n++; fields.push(logField(r.target.text || keyLabel(ent, r.key), r.key, isMark ? 'X' : res.show));
      }
      C.placeText(R.doc, items.map(({ page, x, y, size, text }) => ({ page, x, y, size, text })));
      R.placed = items;
    }
    // Remember this form.
    const entries = flat ? R.placed.map(i => ({ key: i.r.key, as: i.r.as, page: i.page + 1, x: i.x, y: i.y, size: i.size, lineText: i.r.target.text })) : {};
    if (!flat) {
      for (const r of rows) if (r.include && r.key) entries[r.target.name] = { key: r.key, as: r.as };
      for (const r of rows) if (r.touched && !r.key) entries[r.target.name] = { skip: true };
    }
    K.P.mappings[R.fp] = { title: R.doc.name, kind: flat ? 'flat' : 'acro', updated: todayIso(), entries };
    K.P.log.unshift({ at: new Date().toISOString(), entity: ent.id, counterparty: cp.value.trim(), file: R.doc.name, fp: R.fp, fields });
    if (K.P.log.length > 5000) K.P.log.length = 5000;
    persist(); touch();
    m.close(); C.renderInsp(); C.updateChrome(); C.redrawPages?.();
    C.toast(`Filled ${n} ${flat ? 'answers' : 'fields'}.${errs.length ? ` ${errs.length} couldn’t be filled.` : ''} Check them on the pages, then save.`, 6000);
  }
  function logField(label, key, value) { const d = keyDef(ent, key); return { label: String(label || '').slice(0, 160), key, value: String(value), ...(d && ENUM_KINDS.has(d.kind) ? { e: true } : {}) }; }
  draw();
}

const fieldLabel = f => (['check', 'radio'].includes(f.kind) && f.kind === 'check' ? f.right || f.tip || f.left || f.inside || f.above : f.tip || f.left || f.above || f.inside || f.right) || f.nice || f.name;

function wrap(text, pos, doc, pageIdx) {
  if (!text.includes('\n') && text.length < 60) return text;
  let W = 595; try { const vp = doc.proxies[pageIdx].getViewport({ scale: 1 }); W = vp.viewBox[2]; } catch {}
  const max = Math.max(20, Math.floor((W - pos.x - 36) / (pos.size * 0.5)));
  return text.split('\n').map(par => { const out = []; let line = ''; for (const w of par.split(/\s+/)) { if ((line + ' ' + w).trim().length > max) { if (line) out.push(line); line = w; } else line = (line + ' ' + w).trim(); } if (line) out.push(line); return out.join('\n'); }).join('\n');
}

function defaultAs(ent, key, field, prev) {
  const d = keyDef(ent, key); const fk = field?.kind || 'text';
  if (fk === 'check') return prev?.startsWith('check') ? prev : 'check';
  if (fk === 'select' || fk === 'radio') return 'select';
  if (d?.kind === 'date') return prev?.startsWith('date:') ? prev : 'date:' + (K.P?.settings?.dateFormat || 'DD-MM-YYYY');
  if (d?.kind === 'country') return prev?.startsWith('country:') ? prev : 'country:name';
  return 'text';
}

function keyOptions(ent) {
  const out = [];
  for (const d of [...entityKeys(ent), ...SPECIAL_KEYS]) out.push([d.label, d.key]);
  for (const r of ROLES) {
    const n = Math.min(8, Math.max(peopleIn(ent, r.role).length, r.role === 'shareholder' ? 0 : 1) + 1);
    for (let i = 1; i <= n; i++) for (const d of personKeys(ent)) out.push([`${r.label} ${i} · ${d.label}`, `${r.role}.${i}.${d.key}`]);
  }
  return out;
}

function guessCounterparty(doc) {
  const prev = K.P.log.find(l => l.file === doc.name);
  return prev?.counterparty || '';
}

// ---- attach stored documents
async function attachDocs() {
  if (!(await ensureUnlocked())) return;
  const ent = curEntity(); const { h, modal } = C;
  if (!ent.docs.length) { C.toast('No documents in the profile yet. Add them under Profile → Documents.', 6000); openProfile('docs'); return; }
  const picks = new Set();
  const list = ent.docs.map(d => {
    const n = ageNote(d); const id = 'ad-' + d.id;
    const cb = h('input', { type: 'checkbox', id }); cb.onchange = () => { cb.checked ? picks.add(d) : picks.delete(d); };
    const owner = d.owner ? ent.people.find(p => p.id === d.owner) : null;
    return h('label', { class: 'opt' + (n.bad ? ' bad' : ''), for: id }, cb, h('div', {}, `${d.title}`, h('small', {}, `${docTypeInfo(d.type)[1]}${owner ? ' · ' + personName(owner) : ''} · ${n.text}`)));
  });
  const m = modal('Attach documents', h('p', { class: 'hint' }, 'Their pages are added at the end of this document, in the order ticked.'), h('div', { class: 'kattach' }, list),
    h('div', { class: 'actions' }, h('button', { class: 'btn quiet', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: go }, 'Attach')));
  async function go() {
    if (!picks.size) return;
    const old = [...picks].filter(d => ageNote(d).bad);
    m.close();
    const b = C.busy('Decrypting…'); const entries = [];
    try { for (const d of picks) entries.push(await docEntry(d)); } catch (e) { b.done(); C.toast(errMsg(e), 7000); return; }
    b.done();
    await C.insertEntries(entries, C.S.pages.length);
    if (old.length) setTimeout(() => C.toast(`Heads-up: ${old.map(d => d.title).join(', ')} ${old.length > 1 ? 'are' : 'is'} older than counterparties usually accept.`, 8000), 3800);
  }
}

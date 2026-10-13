// Profile screens: unlock and setup, the profile editor, filling a form from the profile,
// attaching stored documents, and the record of what was sent to whom.

import * as host from '../host.js';
import { GROUPS, ENTITY_KEYS, PERSON_KEYS, ROLES, SPECIAL_KEYS, DOC_TYPES, docTypeInfo, entityKeys, personKeys, keyDef, keyLabel, roleInfo, newEntity, ENUM_KINDS } from './schema.js';
import { COUNTRIES } from './countries.js';
import { K, V, refreshInfo, unlockWith, createWith, lockNow, pruneLog, persist, flush, setValue, computed, rawValue, peopleIn, todayIso, entityById, errKind, errMsg, setSaveErrorHandler, onChange } from './vault.js';
import { pageLines, describeFields, flatLines, fingerprint, sha256 } from './extract.js';
import { loadOffice, isOfficeName } from './office.js';
import { localFields, claudeMatch, libLabel, libKey, isQuestionLine, lineLabel } from './match.js';
import { initFill, endFill, fillKind, fillName, drawFill, fillNow } from './fill.js';
import { harvestForm, initHarvest } from './harvest.js';
import { dateInput } from './datefield.js';
import { prepare, pdfjsLib } from '../engine.js';

let C; // context from main.js
const IDLE_MS = 15 * 60 * 1000;
let lastUse = Date.now();
const touch = () => (lastUse = Date.now());
setInterval(() => { if (K.P && Date.now() - lastUse > IDLE_MS) lockNow().then(() => afterLock('Profile locked after 15 minutes without use.')); }, 30000);
/** After any lock: the decrypted profile leaves the page, open screens close, a running fill ends. */
function afterLock(msg) { K.P = null; endFill(); view.sec = 'form'; refreshInfo().catch(() => {}).finally(() => { renderKyc(); C?.renderInsp(); }); if (msg) C?.toast(msg, 6000); }

const fmtDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : iso || ''; };
const daysSince = iso => Math.floor((Date.now() - new Date(iso + 'T00:00:00').getTime()) / 86400000);
const LS_ENT = 'proof.kyc.entity';
export function curEntity() {
  if (!K.P?.entities.length) return null;
  let id = null; try { id = localStorage.getItem(LS_ENT); } catch {}
  return entityById(id) || K.P.entities[0];
}
export function setCurEntity(id) { try { localStorage.setItem(LS_ENT, id); } catch {} }

export function initKyc(ctx) {
  C = ctx;
  setSaveErrorHandler(async e => {
    if (errKind(e) === 'LOCKED') { afterLock(); C.renderInsp(); C.toast('Profile locked. Last change not saved.', 7000); return; }
    if (errKind(e) === 'CONFLICT') return conflict();
    C.toast('Couldn’t save the profile: ' + errMsg(e), 8000);
  });
  onChange(() => { const st = document.querySelector('#kycnav .kstate'); if (st) st.textContent = K.dirty ? 'Saving…' : ''; });
  initFill(C); initHarvest(C);
  C.hooks.layout = () => { if (layoutKyc() && C.mode() === 'kyc') { drawNav(); if (view.sec === 'form' && !fillKind()) drawPane(); } };
  C.hooks.show = () => renderKyc();
  refreshInfo().catch(() => {}).finally(() => renderKyc());
  document.getElementById('kycpane')?.addEventListener('pointerdown', touch);
  document.getElementById('kycnav')?.addEventListener('pointerdown', touch);
  host.onEvent('vault-locked', () => { if (K.P) afterLock('Profile locked after 15 minutes without use.'); });
  if (!host.isDesktop) import('./schema.js').then(schema => (window.__kyc = { K, V, setValue, flush, schema, rawValue }));
}

async function conflict() {
  const { h, modal } = C;
  const m = modal('Profile changed elsewhere',
    h('p', {}, 'Someone (or Proof on another computer) saved the profile file after you opened it. Your last edit isn’t saved yet.'),
    h('p', { class: 'hint' }, 'Reload to see their version (your unsaved edit is dropped), or keep yours (their changes since you opened it are overwritten).'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: async () => { m.close(); await V.lock(); K.dirty = false; afterLock(); } }, 'Reload theirs'),
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
    const name = h('input', { type: 'text', id: 'kyc-ent', });
    const p1 = h('input', { type: 'password', id: 'kyc-p1', autocomplete: 'new-password' }), p2 = h('input', { type: 'password', id: 'kyc-p2', autocomplete: 'new-password' });
    const where = h('p', { class: 'hint' }, info.path);
    const msg = h('p', { class: 'msg', role: 'alert' });
    const go = h('button', { class: 'btn primary', onclick: ok }, 'Create profile');
    const m = modal('Set up your profile',
      h('label', { class: 'fld', for: 'kyc-ent' }, h('span', { class: 'lbl' }, 'First entity'), name),
      h('label', { class: 'fld', for: 'kyc-p1' }, h('span', { class: 'lbl' }, 'Passphrase (12+ characters)'), p1),
      h('label', { class: 'fld', for: 'kyc-p2' }, h('span', { class: 'lbl' }, 'Same again'), p2),
      h('p', { class: 'hint' }, 'A forgotten passphrase can’t be recovered.'),
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
      if (p1.value.length < 12) { msg.textContent = 'Use at least 12 characters. A few unrelated words works well.'; return; }
      if (p1.value !== p2.value) { msg.textContent = 'The passphrases don’t match.'; return; }
      go.disabled = true; go.textContent = 'Creating…';
      try { await createWith(p1.value, name.value.trim(), path); m.close(); touch(); resolve(true); }
      catch (e) { go.disabled = false; go.textContent = 'Create profile'; msg.textContent = errMsg(e); }
    }
  });
}

// ---------------------------------------------------------------- the KYC workspace
// Left: navigation (the form you're filling, then the profile, then records and settings).
// Middle: the form's pages (shared with the PDF tab), a Word/Excel preview, or a profile page.
// Right: the fill list while a form is open.
let view = { sec: 'form', person: null };
const $id = id => document.getElementById(id);

export function showForm() { view.sec = 'form'; view.person = null; renderKyc(); }
export async function openProfile(sec) { C.setMode('kyc'); view.sec = sec || 'identity'; view.person = null; renderKyc(); }
/** Older name: leave a profile page and go back to the form. */
export function closePanel() { flush().catch(() => {}); showForm(); }
function drawPanel() { renderKyc(); }

/** Set the layout classes. Returns true when the visible arrangement changed. */
export function layoutKyc() {
  const app = $id('app'); if (!app || !C) return false;
  const before = app.className;
  const kind = C.mode() === 'kyc' && view.sec === 'form' && K.P ? fillKind() : null;
  app.classList.toggle('kv-view', kind === 'pdf');
  app.classList.toggle('kv-office', kind === 'office');
  app.classList.toggle('has-fill', !!fillKind());
  return app.className !== before;
}

export function renderKyc() {
  if (!C || C.mode() !== 'kyc') { layoutKyc(); return; }
  const changed = layoutKyc();
  drawNav();
  if (view.sec === 'form' && K.P && fillKind()) drawFill(); else drawPane();
  if (changed) C.relayout();
}

function drawNav() {
  const nav = $id('kycnav'); if (!nav) return;
  const { h } = C;
  if (!K.P) { nav.replaceChildren(h('div', { class: 'kn-h' }, h('h2', {}, 'KYC'), h('p', { class: 'hint' }, K.info?.exists ? 'Your profile is locked.' : 'No profile yet.'))); return; }
  const ent = curEntity();
  const entSel = h('select', { 'aria-label': 'Entity', class: 'entsel' }, K.P.entities.map(e => h('option', { value: e.id }, e.name)), h('option', { value: '+' }, 'Add an entity…'));
  if (ent) entSel.value = ent.id;
  entSel.onchange = () => { if (entSel.value === '+') return addEntity(); setCurEntity(entSel.value); view.person = null; renderKyc(); };
  const count = {
    people: ent ? ent.people.filter(p => !p.until || p.until > todayIso()).length : 0,
    docs: ent?.docs.length || 0, log: K.P.log.filter(l => l.entity === ent?.id).length, forms: Object.keys(K.P.mappings).length, library: Object.keys(K.P.library || {}).length,
  };
  const formLabel = fillName();
  const items = [['form', formLabel ? 'Form: ' + formLabel : 'Fill a form'], '-', ...GROUPS, ['people', 'People'], ['docs', 'Documents'], ['custom', 'Custom items'], '-', ['log', 'Fill record'], ['forms', 'Saved forms'], ['library', 'Label library'], ['settings', 'Settings']];
  nav.replaceChildren(
    h('div', { class: 'kn-h' }, entSel,
      h('div', { class: 'kn-st' }, h('span', { class: 'kstate' }, K.dirty ? 'Saving…' : ''), h('button', { class: 'lnk', onclick: async () => { await lockNow(); afterLock('Profile locked.'); } }, 'Lock'))),
    h('div', { class: 'kn' }, items.map(it => it === '-' ? h('hr') : h('button', { 'aria-pressed': String(view.sec === it[0]), class: it[0] === 'form' && formLabel ? 'live' : null, title: it[0] === 'form' && formLabel ? formLabel : null, onclick: () => { if (view.sec !== 'form') flush().catch(() => {}); view.sec = it[0]; view.person = null; renderKyc(); } }, h('span', {}, it[1]), count[it[0]] ? h('b', {}, count[it[0]]) : null))));
}

function drawPane() {
  const pane = $id('kycpane'); if (!pane) return;
  const { h } = C;
  const keep = pane.dataset.sec === view.sec + '|' + (view.person || '');
  const top = keep ? pane.scrollTop : 0;
  pane.dataset.sec = view.sec + '|' + (view.person || '');
  pane.classList.remove('office');
  if (!K.P) { pane.replaceChildren(K.info?.exists ? unlockCard() : setupCard()); pane.scrollTop = 0; return; }
  const ent = curEntity();
  const content = view.sec === 'form' ? homeView(ent) : ent || ['settings', 'forms', 'library'].includes(view.sec) ? section(ent) : h('p', { class: 'hint' }, 'Add an entity to begin.');
  pane.replaceChildren(content);
  pane.scrollTop = top;
}

// ---- the start of the KYC tab: fill a form, or build the profile from one you've filled before
function homeView(ent) {
  const { h } = C;
  const doc = C.S.docs.find(d => !d.hidden && C.S.pages.some(p => p.doc === d));
  const recent = K.P.log.filter(l => l.entity === ent?.id).slice(0, 6);
  const filled = ent ? entityKeys(ent).filter(d => rawValue(ent, d.key)).length : 0;
  const drop = h('div', { class: 'kdrop', role: 'button', tabindex: '0', onclick: () => fillNow(true), onkeydown: e => { if (e.key === 'Enter') fillNow(true); } },
    h('b', {}, 'Open a form to fill'), h('span', {}, 'PDF, Word or Excel'));
  return h('section', { class: 'kblock' },
    h('h2', {}, 'Fill a form'),
    drop,
    doc ? h('div', { class: 'kcard' }, h('div', {}, h('b', {}, doc.name)), h('button', { class: 'btn primary', onclick: () => fillNow(false) }, 'Fill')) : null,
    h('div', { class: 'kblock2' }, h('h3', {}, 'Import from a filled form'),
      h('div', { class: 'btns' }, h('button', { class: filled < 8 ? 'btn primary' : 'btn', onclick: () => harvestForm(ent) }, 'Choose file…'))),
    recent.length ? h('div', { class: 'kblock2' }, h('h3', {}, 'Recently filled'),
      h('div', { class: 'krecent' }, recent.map(l => h('div', {}, h('b', {}, l.counterparty || '—'), h('span', {}, `${l.file} · ${fmtDate(l.at.slice(0, 10))} · ${l.fields.length} answers`)))),
      h('div', { class: 'btns' }, h('button', { class: 'btn quiet', onclick: () => { view.sec = 'log'; renderKyc(); } }, 'Full record'))) : null);
}

// ---- unlock and set up, in the tab itself
function unlockCard() {
  const { h } = C;
  const pw = h('input', { type: 'password', id: 'ku-pw', autocomplete: 'current-password' });
  const msg = h('p', { class: 'msg', role: 'alert' });
  const go = h('button', { class: 'btn primary', onclick: ok }, 'Unlock');
  pw.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
  async function ok() {
    go.disabled = true; msg.textContent = '';
    try { await unlockWith(pw.value); touch(); renderKyc(); C.renderInsp(); }
    catch (e) { go.disabled = false; msg.textContent = errMsg(e); pw.select(); }
  }
  requestAnimationFrame(() => pw.focus());
  return h('section', { class: 'kblock kgate' }, h('h2', {}, 'Unlock'), h('p', { class: 'hint' }, K.info?.path || ''),
    h('label', { class: 'fld', for: 'ku-pw' }, h('span', { class: 'lbl' }, 'Passphrase'), pw), msg, h('div', { class: 'btns' }, go));
}

function setupCard() {
  const { h } = C; let path = null;
  const name = h('input', { type: 'text', id: 'ks-ent' });
  const p1 = h('input', { type: 'password', id: 'ks-p1', autocomplete: 'new-password' }), p2 = h('input', { type: 'password', id: 'ks-p2', autocomplete: 'new-password' });
  const where = h('span', { class: 'hint' }, K.info?.path || '');
  const msg = h('p', { class: 'msg', role: 'alert' });
  const go = h('button', { class: 'btn primary', onclick: ok }, 'Create profile');
  async function ok() {
    msg.textContent = '';
    if (!name.value.trim()) { msg.textContent = 'Name the entity.'; return; }
    if (p1.value.length < 12) { msg.textContent = 'Use at least 12 characters. A few unrelated words works well.'; return; }
    if (p1.value !== p2.value) { msg.textContent = 'The passphrases don’t match.'; return; }
    go.disabled = true; go.textContent = 'Creating…';
    try { await createWith(p1.value, name.value.trim(), path); touch(); showForm(); }
    catch (e) { go.disabled = false; go.textContent = 'Create profile'; msg.textContent = errMsg(e); }
  }
  requestAnimationFrame(() => name.focus());
  return h('section', { class: 'kblock kgate' },
    h('h2', {}, 'Set up KYC'),
    h('label', { class: 'fld', for: 'ks-ent' }, h('span', { class: 'lbl' }, 'Legal name of the entity'), name),
    h('label', { class: 'fld', for: 'ks-p1' }, h('span', { class: 'lbl' }, 'Passphrase (12+ characters)'), p1),
    h('label', { class: 'fld', for: 'ks-p2' }, h('span', { class: 'lbl' }, 'Same again'), p2),
    h('p', { class: 'hint' }, 'A forgotten passphrase can’t be recovered.'),
    h('div', { class: 'fld' }, h('span', { class: 'lbl' }, 'Saved at'), where,
      host.isDesktop ? h('div', { class: 'btns' },
        h('button', { class: 'btn quiet', onclick: async () => { const p = await host.pickSave(K.info?.path, { name: 'Proof profile', ext: 'vault' }); if (p) { path = p; where.textContent = p; } } }, 'Choose location…'),
        h('button', { class: 'btn quiet', onclick: async () => {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const p = await open({ multiple: false, filters: [{ name: 'Proof profile', extensions: ['vault'] }] }); if (!p) return;
          try { await V.use(p); await refreshInfo(); renderKyc(); } catch (e) { msg.textContent = errMsg(e); }
        } }, 'Use an existing profile…')) : null),
    msg, h('div', { class: 'btns' }, go));
}

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
  return ({ people: peopleView, docs: docsView, custom: customView, log: logView, forms: formsView, library: libraryView, settings: settingsView })[s](ent);
}

// ---- value editors
const countryOpts = (h) => [h('option', { value: '' }, '—'), ...COUNTRIES.map(([c, , n]) => h('option', { value: c }, n))];
function editor(bag, def, ent, onSet) {
  const { h } = C; const cur = bag[def.key]?.v ?? '';
  const id = 'kv-' + def.key + '-' + Math.random().toString(36).slice(2, 7);
  let ctl;
  // A change refreshes the one-line previews of computed items in place; redrawing would lose the cursor.
  const set = v => { if (setValue(bag, def, v)) { meta.replaceWith(metaFor()); onSet?.(); $id('kycpane')?.querySelectorAll('.krow').forEach(r => r.refresh?.()); } };
  if (def.kind === 'longtext') { ctl = h('textarea', { id, rows: '3' }); ctl.value = cur; ctl.addEventListener('change', () => set(ctl.value)); }
  else if (def.kind === 'date') ctl = dateInput(h, cur, v => set(v), { id });
  else if (def.kind === 'country') { ctl = h('select', { id }, countryOpts(h)); ctl.value = cur; ctl.addEventListener('change', () => set(ctl.value)); }
  else if (def.kind === 'bool') { ctl = h('select', { id }, h('option', { value: '' }, '—'), h('option', { value: 'yes' }, 'Yes'), h('option', { value: 'no' }, 'No')); ctl.value = cur; ctl.addEventListener('change', () => set(ctl.value)); }
  else if (def.kind === 'choice') { ctl = h('select', { id }, h('option', { value: '' }, '—'), def.choices.map(c => h('option', { value: c }, c))); ctl.value = cur; ctl.addEventListener('change', () => set(ctl.value)); }
  else {
    ctl = h('input', { type: 'text', id, inputmode: def.kind === 'number' ? 'decimal' : null, spellcheck: 'false' }); ctl.value = cur;
    if (def.kind === 'computed') ctl.placeholder = computedPreview(bag, def, ent) || '';
    ctl.addEventListener('change', () => set(ctl.value.trim()));
  }
  let meta = metaFor();
  function metaFor() {
    const v = bag[def.key];
    const hist = v?.hist || [];
    const bits = [];
    const line = h('div', { class: 'kmeta' }, bits.join(' · '));
    if (hist.length) {
      const d = h('details', {}, h('summary', { tabindex: '-1' }, `${hist.length} earlier value${hist.length > 1 ? 's' : ''}`),
        h('table', { class: 'khist' }, hist.map(x => h('tr', {}, h('td', {}, displayVal(def, x.v)), h('td', {}, `${fmtDate(x.at)} → ${fmtDate(x.until)}`)))));
      line.append(d);
    }
    return line;
  }
  const row = h('div', { class: 'krow', 'data-key': def.key }, h('label', { class: 'lbl', for: id }, def.label), ctl, meta);
  if (def.kind === 'computed') row.refresh = () => { ctl.placeholder = computedPreview(bag, def, ent) || ''; };
  return row;
}
function computedPreview(bag, def, ent) { const tmp = { ...bag }; delete tmp[def.key]; return computed(def, tmp, ent); }
function displayVal(def, v) { if (def.kind === 'country') return COUNTRIES.find(c => c[0] === v)?.[2] || v; if (def.kind === 'date') return fmtDate(v); if (def.kind === 'bool') return v === 'yes' ? 'Yes' : v === 'no' ? 'No' : v; return v; }

function groupEditor(ent, g) {
  const { h } = C;
  const defs = entityKeys(ent).filter(d => d.group === g);
  const title = GROUPS.find(x => x[0] === g)[1];
  const wrap = h('div', { class: 'kgrid' });
  const same = () => ent.values.op_same?.v === 'yes';
  const applySame = () => wrap.querySelectorAll('.krow[data-key^="op_"]').forEach(r => (r.hidden = same()));
  wrap.replaceChildren(...defs.map(d => d.key === 'op_same' ? sameBox(d) : editor(ent.values, d, ent, () => { if (d.key === 'legal_name' && ent.values.legal_name?.v) { ent.name = ent.values.legal_name.v; persist(); } })));
  applySame();
  function sameBox(d) {
    const cb = h('input', { type: 'checkbox', id: 'kv-op-same' }); cb.checked = same();
    cb.onchange = () => { setValue(ent.values, d, cb.checked ? 'yes' : 'no'); applySame(); };
    return h('label', { class: 'opt ksame', for: 'kv-op-same' }, cb, h('div', {}, d.label));
  }
  const del = g === 'identity' ? h('div', { class: 'btns kdel' }, h('button', { class: 'btn quiet danger', onclick: () => deleteEntity(ent) }, 'Delete entity…')) : null;
  return h('section', { class: 'kblock' }, h('h2', {}, title), wrap, del);
}
function deleteEntity(ent) {
  confirmDo(`Delete ${ent.name}?`, 'Its values, people and stored documents are removed from the profile. The fill record keeps what was sent.', 'Delete entity', async () => {
    for (const d of ent.docs) { try { await V.docDelete(d.id); } catch {} }
    K.P.entities = K.P.entities.filter(e => e !== ent);
    if (K.P.entities[0]) setCurEntity(K.P.entities[0].id);
    persist(); view.sec = K.P.entities.length ? 'identity' : 'form'; view.person = null; renderKyc();
  });
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
    h('p', { class: 'hint' }, 'Order sets numbering on forms (UBO 1, UBO 2…).'),
    h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => add('person') }, 'Add a person'), h('button', { class: 'btn', onclick: () => add('company') }, 'Add a company')),
    h('div', { class: 'kplist' }, cur.length ? cur.map(row) : h('p', { class: 'hint' }, 'None')),
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
  const until = dateInput(h, p.until || '', v => { p.until = v || undefined; persist(); }, { id: 'p-until' });
  return h('section', { class: 'kblock' },
    h('div', { class: 'btns' }, h('button', { class: 'btn quiet', onclick: () => { view.person = null; drawPanel(); } }, '← People')),
    h('h2', {}, personName(p)),
    h('div', { class: 'kblock2' }, h('h3', {}, 'Roles'), roles),
    ...blocks,
    h('div', { class: 'kblock2' }, h('h3', {}, 'Leaving'),
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
  if (d.issued && max && daysSince(d.issued) > max) return { bad: true, text: `Issued ${daysSince(d.issued)} days ago (usual limit ${Math.round(max / 30)} months)` };
  if (d.issued) return { text: `Issued ${daysSince(d.issued)} days ago` };
  return { text: 'Issue date not set' };
}
async function addDocs(ent, owner = '') {
  let files = await host.pickOpen({ title: 'Add documents to the profile' }); if (!files.length) return;
  if (files.some(f => isOfficeName(f.name))) { C.toast('Documents must be PDF or image files.', 7000); files = files.filter(f => !isOfficeName(f.name)); if (!files.length) return; }
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
    const issued = dateInput(h, d.issued || '', v => { d.issued = v; upd(); }, { 'aria-label': 'Issued' });
    const expires = dateInput(h, d.expires || '', v => { d.expires = v; upd(); }, { 'aria-label': 'Expires' });
    const owner = h('select', { 'aria-label': 'About' }, h('option', { value: '' }, 'The entity'), ent.people.map(p => h('option', { value: p.id }, personName(p)))); owner.value = d.owner || '';
    const note = ageNote(d);
    function upd() { d.type = type.value; d.title = title.value; d.owner = owner.value; persist(); drawPanel(); }
    [type, owner].forEach(x => x.addEventListener('change', upd)); title.addEventListener('change', upd);
    return h('div', { class: 'kdoc' + (note.bad ? ' bad' : '') },
      h('div', { class: 'kdg' }, h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Type'), type), h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Title'), title)),
      h('div', { class: 'kdg3' }, h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Issued'), issued), h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Expires'), expires), h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'About'), owner)),
      h('div', { class: 'kdf' }, h('span', { class: 'kmeta' }, `${d.file} · ${Math.max(1, Math.round(d.size / 1024))} KB · ${note.text}`), h('span', { class: 'sp' }),
        h('button', { class: 'btn quiet', onclick: async () => { try { const e = await docEntry(d); C.setMode('pdf'); C.S.pages.length ? C.insertEntries([e]) : C.openEntries([e]); } catch (er) { C.toast(errMsg(er), 6000); } } }, C.S.pages.length ? 'Insert into the open PDF' : 'Open in the PDF tab'),
        h('button', { class: 'btn quiet', onclick: async () => { const p = await host.pickSave(d.file || d.title + '.pdf', { name: 'Document', ext: (d.file || '.pdf').split('.').pop() }); if (!p) return; try { await host.writePath(p, (await docEntry(d)).bytes); C.toast('Saved an unencrypted copy.'); } catch (er) { C.toast(errMsg(er), 6000); } } }, 'Save a copy…'),
        h('button', { class: 'btn quiet', onclick: async () => { const f = await host.pickOpen({ multiple: false }); if (!f.length) return; try { await V.docPut(d.id, f[0].bytes); d.file = f[0].name; d.mime = f[0].type; d.size = f[0].bytes.length; d.issued = ''; persist(); drawPanel(); C.toast('Replaced. Set the new issue date.'); } catch (er) { C.toast(errMsg(er), 6000); } } }, 'Replace…'),
        h('button', { class: 'btn quiet danger', onclick: () => confirmDo('Delete this document?', `${d.title} is removed from the profile.`, 'Delete', async () => { try { await V.docDelete(d.id); } catch {} ent.docs = ent.docs.filter(x => x !== d); persist(); drawPanel(); }) }, 'Delete')));
  });
  return h('section', { class: 'kblock' }, h('h2', {}, 'Documents'),
    h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => addDocs(ent) }, 'Add documents…')),
    rows.length ? h('div', { class: 'kdocs' }, rows) : h('p', { class: 'hint' }, 'None'));
}

// ---- custom items
function customView(ent) {
  const { h } = C;
  const label = h('input', { type: 'text', id: 'cu-l' });
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
      h('summary', {}, h('b', {}, l.counterparty || '—'), h('span', {}, `${fmtDate(l.at.slice(0, 10))} · ${l.file} · ${l.fields.length} answers`)),
      h('table', { class: 'ktab' }, h('tr', {}, h('th', {}, 'Field'), h('th', {}, 'Item'), h('th', {}, 'Value')), l.fields.map(f => h('tr', {}, h('td', {}, f.label), h('td', {}, keyLabel(ent, f.key) || f.key), h('td', {}, String(f.value))))),
      h('div', { class: 'btns' }, h('button', { class: 'btn quiet danger', onclick: () => confirmDo('Delete this record?', 'It can’t be brought back.', 'Delete', () => { K.P.log = K.P.log.filter(x => x !== l); persist(); draw(); }) }, 'Delete record'))))
      : [h('p', { class: 'hint' }, t ? 'Nothing matches.' : 'No records')]));
  };
  q.addEventListener('input', draw); draw();
  return h('section', { class: 'kblock' }, h('h2', {}, 'Fill record'), q, list);
}

function formsView() {
  const { h } = C;
  const ms = Object.entries(K.P.mappings).sort((a, b) => (b[1].updated || '').localeCompare(a[1].updated || ''));
  return h('section', { class: 'kblock' }, h('h2', {}, 'Saved forms'),
    ms.length ? h('div', {}, ms.map(([fp, m]) => h('div', { class: 'file' }, h('span', { class: 'nm', title: m.title }, m.title), h('span', { class: 'pp' }, `${({ flat: 'flat PDF', acro: 'fillable PDF', docx: 'Word', xlsx: 'Excel' })[m.kind] || m.kind} · ${m.kind === 'flat' ? m.entries.length : Object.keys(m.entries).length} answers · ${fmtDate(m.updated)}`),
      h('button', { class: 'x', 'aria-label': 'Forget ' + m.title, onclick: () => { delete K.P.mappings[fp]; persist(); drawPanel(); } }, '×')))) : h('p', { class: 'hint' }, 'None'));
}

// ---- label library
const libItemLabel = (ent, key) => key.startsWith('person:') ? `Person · ${personKeys(ent).find(d => d.key === key.slice(7))?.label || key.slice(7)}` : keyLabel(ent, key) || key;
function libOptions(ent) {
  return [...entityKeys(ent), ...SPECIAL_KEYS].map(d => [d.label, d.key]).concat(personKeys(ent).map(d => [`Person · ${d.label}`, 'person:' + d.key]));
}
function libraryView(ent) {
  const { h } = C;
  const q = h('input', { type: 'text', placeholder: 'Search labels', 'aria-label': 'Search' });
  const list = h('div', { class: 'klib' });
  const draw = () => {
    const t = q.value.toLowerCase().trim();
    const rows = Object.entries(K.P.library || {}).filter(([k, e]) => !t || k.includes(t) || libItemLabel(ent, e.key).toLowerCase().includes(t)).sort((a, b) => (b[1].n || 0) - (a[1].n || 0) || a[0].localeCompare(b[0]));
    list.replaceChildren(...(rows.length ? [h('table', { class: 'ktab' }, h('tr', {}, h('th', {}, 'Label on forms'), h('th', {}, 'Profile item'), h('th', {}, 'Used'), h('th', {}, '')),
      rows.slice(0, 500).map(([k, e]) => h('tr', {}, h('td', {}, k), h('td', {}, libItemLabel(ent, e.key) + (e.as ? ` (${e.as})` : '')), h('td', {}, e.seed && !e.n ? 'imported' : String(e.n || 0)),
        h('td', {}, h('button', { class: 'x', 'aria-label': 'Forget ' + k, onclick: () => { delete K.P.library[k]; persist(); draw(); } }, '×')))))]
      : [h('p', { class: 'hint' }, t ? 'Nothing matches.' : 'No labels')]));
  };
  q.addEventListener('input', draw); draw();
  return h('section', { class: 'kblock' }, h('h2', {}, 'Label library'),
    h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => importForms(ent) }, 'Learn from forms…')), q, list);
}

export async function pdfDoc(bytes) {
  const prep = await prepare(bytes, async () => null);
  const pdf = await pdfjsLib.getDocument({ data: prep.bytes.slice(), isEvalSupported: false }).promise;
  const proxies = []; for (let i = 0; i < pdf.numPages; i++) proxies.push(await pdf.getPage(i + 1));
  return { bytes: prep.bytes, proxies, pdf };
}

/** Read a batch of counterparty forms, propose an item for each new label, and add what you confirm. */
async function importForms(ent) {
  const files = (await host.pickOpen({ title: 'Choose counterparty forms to learn from', office: true })).filter(f => isOfficeName(f.name) || /\.pdf$/i.test(f.name));
  if (!files.length) return;
  const b = C.busy('Reading forms…'); const seen = new Map(); const failed = [];
  for (const [i, f] of files.entries()) {
    b.set(`Reading ${i + 1} of ${files.length}: ${f.name}`);
    try {
      let descs;
      if (isOfficeName(f.name)) descs = (await loadOffice(f.bytes, f.name)).slots;
      else {
        const doc = await pdfDoc(f.bytes);
        const lines = await pageLines(doc); const fields = await describeFields(doc, lines);
        descs = fields.length ? fields : flatLines(lines).filter(l => !l.heading && isQuestionLine(l)).map(l => ({ kind: 'text', tip: lineLabel(l.text), left: '', above: '', inside: '', right: '', below: '', nice: '', section: '', ctx: [], options: [], page: l.page, near: '' }));
        doc.pdf.destroy?.();
      }
      for (const d of descs) {
        if (d.ro) continue;
        const lab = libLabel(d); const k = libKey(lab);
        if (!k || k.length < 2 || (K.P.library || {})[k]) continue;
        const e = seen.get(k); if (e) { e.forms.add(f.name); continue; }
        seen.set(k, { k, lab, d: { ...d, id: 'f' + (seen.size + 1) }, forms: new Set([f.name]) });
      }
    } catch { failed.push(f.name); }
  }
  b.done();
  if (!seen.size) { C.toast(failed.length ? `Couldn’t read ${failed.join(', ')}.` : 'No new labels.', 7000); return; }
  const items = [...seen.values()];
  const props = new Map(localFields(ent, items.map(x => x.d)).map(p => [p.id, p]));
  const info = await refreshInfo().catch(() => ({}));
  let usedClaude = false;
  const open = items.filter(x => !props.get(x.d.id)?.key);
  if (open.length && info.has_key && K.P.settings.useClaude !== false) {
    const bb = C.busy('Asking Claude about the rest (labels only)…');
    try { const { matches } = await claudeMatch(ent, { fields: open.map(x => x.d) }, (i, n) => bb.set(`Asking Claude… ${i}/${n}`)); for (const m of matches) if (m.key) props.set(m.id, m); usedClaude = true; }
    catch (e) { C.toast('Claude matching failed: ' + errMsg(e), 7000); }
    finally { bb.done(); }
  }
  const asItem = key => { const m = /^[a-z_]+\.\d+\.([a-z0-9_]+)$/.exec(key || ''); return m ? 'person:' + m[1] : key || null; };
  const rows = items.map(x => { const p = props.get(x.d.id); return { ...x, key: asItem(p?.key), as: x.d.kind === 'check' ? p?.as : undefined, conf: p?.confidence, include: !!p?.key && p.confidence !== 'low' }; })
    .sort((a, b) => b.forms.size - a.forms.size || a.k.localeCompare(b.k));
  const { h, modal } = C; const opts = libOptions(ent); const byLabel = new Map(opts);
  const dl = h('datalist', { id: 'lib-keys' }, opts.map(([l]) => h('option', { value: l })));
  const body = h('div', { class: 'rv-rows' });
  const count = h('span', { class: 'rv-count' });
  const save = h('button', { class: 'btn primary', onclick: done }, 'Add');
  const draw = () => {
    body.replaceChildren(...rows.map(r => {
      const cb = h('input', { type: 'checkbox', checked: r.include, disabled: !r.key, 'aria-label': 'Add' }); cb.onchange = () => { r.include = cb.checked; tally(); };
      const it = h('input', { type: 'text', list: 'lib-keys', placeholder: '— skip', value: r.key ? libItemLabel(ent, r.key) : '' });
      it.onchange = () => { const v = it.value.trim(); r.key = v ? byLabel.get(v) || null : null; r.include = !!r.key; draw(); };
      return h('div', { class: 'rv-row lib' + (r.include ? ' on' : '') }, cb, h('div', { class: 'rv-f' }, h('b', {}, r.lab), h('small', {}, `${r.forms.size} form${r.forms.size > 1 ? 's' : ''}${r.d.kind !== 'text' ? ' · ' + r.d.kind : ''}`)), h('div', { class: 'rv-k' }, it, r.as ? h('small', { class: 'rv-note' }, r.as) : null), r.conf ? h('span', { class: 'chip c-' + r.conf }, r.conf) : h('span', {}));
    }));
    tally();
  };
  const tally = () => { const n = rows.filter(r => r.include && r.key).length; count.textContent = `${rows.length} new labels · ${n} to add`; save.textContent = n ? `Add ${n}` : 'Add'; save.disabled = !n; };
  const m = modal('Learn from forms', h('p', { class: 'hint' }, `${files.length - failed.length} form${files.length - failed.length > 1 ? 's' : ''} read${failed.length ? `, ${failed.length} couldn’t be read` : ''}. ${usedClaude ? 'Some labels matched by Claude. ' : ''}`), body, dl,
    h('div', { class: 'rv-foot' }, count), h('div', { class: 'actions' }, h('button', { class: 'btn quiet', onclick: () => m.close() }, 'Cancel'), save));
  m.modal.classList.add('wide');
  draw();
  function done() {
    const L = (K.P.library ||= {}); let n = 0; const at = todayIso();
    for (const r of rows) if (r.include && r.key) { L[r.k] = { key: r.key, ...(r.as ? { as: r.as } : {}), n: 0, at, seed: true }; n++; }
    persist(); m.close(); drawPanel(); C.toast(`Added ${n} labels to the library.`);
  }
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
      h('label', { class: 'opt', for: 'st-use' }, use, h('div', {}, 'Offer Claude matching', h('small', {}, 'Labels only. Profile values are never sent.'))),
      h('label', { class: 'fld', for: 'st-key' }, h('span', { class: 'lbl' }, 'Anthropic API key'), key),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: async () => { if (!key.value.trim()) return; try { await V.setKey(key.value.trim()); key.value = ''; await refreshInfo(); C.toast('Key stored in Windows Credential Manager.'); drawPanel(); } catch (e) { C.toast(errMsg(e), 7000); } } }, 'Store key'),
        info.has_key ? h('button', { class: 'btn quiet danger', onclick: async () => { await V.setKey(''); await refreshInfo(); drawPanel(); } }, 'Remove key') : null),
      h('label', { class: 'fld', for: 'st-model' }, h('span', { class: 'lbl' }, 'Model'), model)),
    h('div', { class: 'kblock2' }, h('h3', {}, 'Answers'), h('label', { class: 'fld', for: 'st-df' }, h('span', { class: 'lbl' }, 'Default date format'), df)),
    h('div', { class: 'kblock2' }, h('h3', {}, 'Fill record'),
      (() => { const sel = h('select', { id: 'st-ret' }, [[0, 'Keep everything'], [10, '10 years'], [7, '7 years'], [5, '5 years'], [2, '2 years'], [1, '1 year']].map(([v, l]) => h('option', { value: v }, l))); sel.value = String(K.P.settings.logYears || 0);
        sel.onchange = () => { K.P.settings.logYears = +sel.value; const n = pruneLog(); persist(); if (n) C.toast(`Removed ${n} older record${n > 1 ? 's' : ''}.`); drawPanel(); };
        return h('label', { class: 'fld', for: 'st-ret' }, h('span', { class: 'lbl' }, 'Keep records for'), sel); })(),
      h('p', { class: 'hint' }, 'Older records are deleted on unlock.')),
    h('div', { class: 'kblock2' }, h('h3', {}, 'Profile file'),
      h('p', { class: 'hint' }, info.path || ''),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: async () => { const d = await host.pickFolder('Choose a folder for the backup'); if (!d || d.startsWith('download:')) return; try { const n = await V.backup(d); C.toast(`Backed up the profile and ${n} document${n === '1' ? '' : 's'}, still encrypted.`); } catch (e) { C.toast(errMsg(e), 7000); } } }, 'Back up…'),
        host.isDesktop ? h('button', { class: 'btn', onclick: async () => {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const p = await open({ multiple: false, filters: [{ name: 'Proof profile', extensions: ['vault'] }] }); if (!p) return;
          await flush().catch(() => {}); await V.use(p); afterLock();
        } }, 'Open a different profile…') : null)),
    h('div', { class: 'kblock2' }, h('h3', {}, 'Change passphrase'),
      h('div', { class: 'kgrid' }, h('label', { class: 'fld', for: 'st-old' }, h('span', { class: 'lbl' }, 'Current'), old), h('label', { class: 'fld', for: 'st-n1' }, h('span', { class: 'lbl' }, 'New'), n1), h('label', { class: 'fld', for: 'st-n2' }, h('span', { class: 'lbl' }, 'New again'), n2)), pmsg,
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: async () => {
        pmsg.textContent = '';
        if (n1.value !== n2.value) { pmsg.textContent = 'The new passphrases don’t match.'; return; }
        const b = C.busy('Re-encrypting…');
        try { await flush(); await V.passphrase(old.value, n1.value); b.done(); old.value = n1.value = n2.value = ''; C.toast('Passphrase changed.'); } catch (e) { b.done(); pmsg.textContent = errMsg(e); }
      } }, 'Change passphrase'))));
}

// ---- attach stored documents
export async function attachDocs() {
  if (!(await ensureUnlocked())) return;
  const ent = curEntity(); const { h, modal } = C;
  if (!ent.docs.length) { C.toast('No documents in the profile.', 6000); openProfile('docs'); return; }
  const picks = new Set();
  const list = ent.docs.map(d => {
    const n = ageNote(d); const id = 'ad-' + d.id;
    const cb = h('input', { type: 'checkbox', id }); cb.onchange = () => { cb.checked ? picks.add(d) : picks.delete(d); };
    const owner = d.owner ? ent.people.find(p => p.id === d.owner) : null;
    return h('label', { class: 'opt' + (n.bad ? ' bad' : ''), for: id }, cb, h('div', {}, `${d.title}`, h('small', {}, `${docTypeInfo(d.type)[1]}${owner ? ' · ' + personName(owner) : ''} · ${n.text}`)));
  });
  const m = modal('Attach documents', h('div', { class: 'kattach' }, list),
    h('div', { class: 'actions' }, h('button', { class: 'btn quiet', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: go }, 'Attach')));
  async function go() {
    if (!picks.size) return;
    const old = [...picks].filter(d => ageNote(d).bad);
    m.close();
    const b = C.busy('Decrypting…'); const entries = [];
    try { for (const d of picks) entries.push(await docEntry(d)); } catch (e) { b.done(); C.toast(errMsg(e), 7000); return; }
    b.done();
    await C.insertEntries(entries, C.S.pages.length);
    if (old.length) setTimeout(() => C.toast(`Out of date: ${old.map(d => d.title).join(', ')}`, 8000), 3800);
  }
}

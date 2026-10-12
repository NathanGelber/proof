// Fill from profile: one session per form.
//
// Proof fills everything it's sure of straight away and shows it on the pages: green for
// confident answers, amber for ones to check. A short side list holds only what needs a
// decision. Click a field on the page, or a row in the list, to change what goes in it.
// Claude runs on whatever's left, if it's switched on. The counterparty is asked once, at save,
// and that save is when the fill is recorded and the label library learns.
//
// Three kinds of session share this code:
//   pdf    – a PDF with form fields: answers go into the fields, shown on the page as marks;
//   flat   – a PDF without fields: answers are typed onto the page as text you can drag;
//   office – a Word or Excel form: answers go into a copy, with a preview beside the list.

import * as host from '../host.js';
import { ROLES, SPECIAL_KEYS, ENUM_KINDS, entityKeys, personKeys, keyDef, keyLabel, roleInfo } from './schema.js';
import { COUNTRIES } from './countries.js';
import { K, V, persist, setValue, rawValue, peopleIn, todayIso, refreshInfo, errKind, errMsg } from './vault.js';
import { pageLines, describeFields, flatLines, fingerprint, sha256 } from './extract.js';
import { loadOffice, isOfficeName } from './office.js';
import { localFields, localLines, claudeMatch, claudeRequest, render, placeOnLine, yesNoOption, learn, libLabel, isQuestionLine, lineLabel, fieldLabel, autoAs } from './match.js';
import { ensureUnlocked, curEntity, setCurEntity, openProfile, attachDocs } from './ui.js';

let C = null;
let SES = null;

export function initFill(ctx) {
  C = ctx;
  Object.assign(C.hooks, {
    fillNow, marks: drawMarks, pick: pickField, beforeSave,
    reset: () => { if (SES && SES.kind !== 'office') SES = null; },
    itemClass: it => { if (!it.kyc || SES?.kind !== 'flat') return ''; const x = SES.items.find(i => i.itemId === it.id); return x ? ' kyc-' + x.status : ''; },
    itemSelected: id => { const x = SES?.items.find(i => i.itemId === id); if (x) { SES.sel = x.n; SES.picking = null; } },
  });
}

/** Is a fill session running on one of these documents? Then the Form tab shows its list. */
export function fillPanelFor(docs, body) {
  if (!SES || SES.kind === 'office' || !docs.includes(SES.doc) || !C.S.docs.includes(SES.doc)) return false;
  body.append(panel());
  requestAnimationFrame(() => body.querySelector('.fc.sel')?.scrollIntoView({ block: 'nearest' }));
  return true;
}

// ================================================================ starting
async function fillNow() {
  if (!C.S.pages.length) {
    const picked = await host.pickOpen({ multiple: false, title: 'Choose the form to fill' });
    if (!picked.length) return;
    if (isOfficeName(picked[0].name)) return startOffice(picked[0]);
    await C.openEntries(picked);
    if (!C.S.pages.length) return;
  }
  const docs = C.S.docs.filter(d => !d.hidden && C.S.pages.some(p => p.doc === d));
  const target = docs.find(d => d.fields.length) || docs[0];
  if (target) await startPdf(target);
}

async function startPdf(doc, entity) {
  if (!(await ensureUnlocked())) return;
  if (SES && SES.kind !== 'office' && SES.doc === doc && !entity) { C.setTab('form'); return; }
  const ent = entity || curEntity(); if (!ent) { openProfile('identity'); return; }
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
  if (flat && !fl.some(l => !l.heading)) { C.toast('This form has no fillable fields and no text Proof can read (it may be a scan). Use the Text tool, or run it through OCR first.', 8000); return; }
  if (SES && SES.kind !== 'office') clearApplied(SES);
  const saved = K.P.mappings[fp];
  SES = newSession(flat ? 'flat' : 'pdf', ent, fp, saved, { doc });
  C.commit();
  if (flat) buildFlat(fl, saved); else buildFields(fields, saved);
  for (const it of SES.items) { settle(it); apply(it); }
  SES.changed = SES.items.some(i => i.applied);
  C.redrawDoc(doc); C.setTab('form'); C.updateChrome();
  summaryToast();
  runClaude();
}

/** A Word or Excel form opens in its own view: preview on the left, the list on the right. */
export async function startOffice(entry, entity) {
  if (!(await ensureUnlocked())) return;
  const ent = entity || curEntity(); if (!ent) { openProfile('identity'); return; }
  const b = C.busy('Reading the form…'); let od;
  try { od = await loadOffice(entry.bytes, entry.name); }
  catch (e) { b.done(); C.toast(e?.message || String(e), 8000); return; }
  b.done();
  if (!od.slots.length) { C.toast(`Proof couldn’t find any spots for answers in ${entry.name}: no empty cells beside labels, blanks, form fields or tick boxes.`, 8000); return; }
  const fp = 'office:' + await sha256(JSON.stringify([od.kind, od.slots.map(s => [s.name, s.left, s.above, s.tip, s.right])]));
  SES = newSession('office', ent, fp, K.P.mappings[fp], { entry, od });
  buildFields(od.slots, SES.saved);
  for (const it of SES.items) { settle(it); apply(it); }
  openOfficeView();
  summaryToast();
  runClaude();
}

function newSession(kind, ent, fp, saved, extra) {
  const prev = K.P.log.find(l => l.fp === fp);
  return { kind, ent, fp, saved, items: [], byName: new Map(), sel: null, picking: null, open: {}, claude: { state: 'idle' }, counterparty: prev?.counterparty || '', asked: false, logEntry: null, changed: false, ...extra };
}

function addItem(target, p, extra = {}) {
  const it = { n: SES.items.length, target, name: target.name || null, key: p?.key || null, as: p?.as || '', conf: p?.confidence || null, source: p?.source || null, note: p?.note || '', place: p?.place, option: p?.option, label: p?.label, pos: p?.pos || null, status: 'empty', applied: false, touched: false, itemId: null, ...extra };
  SES.items.push(it); if (it.name) SES.byName.set(it.name, it);
  return it;
}

function buildFields(fields, saved) {
  const open = fields.filter(f => !f.ro && !(saved && saved.entries[f.name]));
  const props = new Map(localFields(SES.ent, open).map(p => [p.id, p]));
  for (const f of fields) {
    if (f.ro) continue;
    const e = saved?.entries[f.name];
    if (e?.skip) { addItem(f, null, { touched: true }); continue; }
    if (e) { addItem(f, { key: e.key, as: e.as, confidence: 'saved', source: 'saved' }); continue; }
    addItem(f, props.get(f.id));
  }
}

function buildFlat(lines, saved) {
  SES.lines = lines;
  const byId = new Map(lines.map(l => [l.id, l]));
  if (saved) {
    saved.entries.forEach((e, i) => addItem({ id: 'S' + i, page: e.page, text: e.lineText || '', saved: true }, { key: e.key, as: e.as, confidence: 'saved', source: 'saved', place: e.mark ? 'mark' : 'right', pos: { x: e.x, y: e.y, size: e.size } }));
  } else {
    for (const p of localLines(SES.ent, lines)) addItem(byId.get(p.id), p);
  }
  // Question lines nothing was matched to: listed under "Left empty" so you can assign them.
  const covered = new Set(SES.items.map(i => i.target.id));
  for (const l of lines) if (!l.heading && isQuestionLine(l) && !covered.has(l.id)) addItem(l, null, { place: 'right', label: lineLabel(l.text) });
}

// ================================================================ values and statuses
const fieldOf = it => (SES.kind === 'flat' ? { kind: it.place === 'mark' ? 'check' : 'text', text: it.target.text } : it.target);

const PERSONAL = new Set(['first_name', 'last_name', 'date_of_birth', 'place_of_birth', 'country_of_birth', 'nationality', 'res_street', 'res_postcode', 'res_city', 'res_country', 'res_address', 'pep', 'pep_details', 'id_type', 'id_number', 'id_country', 'id_issued', 'id_expiry']);

function evaluate(it) {
  it.problem = ''; it.missingWhy = ''; it.missing = false; it.na = false; it.value = undefined; it.show = '';
  if (!it.key) return;
  const def = keyDef(SES.ent, it.key);
  const person = def?.scope === 'person' ? peopleIn(SES.ent, def.role)[def.n - 1] : null;
  if (def?.scope === 'person' && !person) { it.missing = true; it.missingWhy = `There’s no ${roleInfo(def.role).label} ${def.n} in your profile.`; return; }
  // A company in a person's slot (a corporate UBO or member) has no birth date or passport.
  if (person?.kind === 'company' && PERSONAL.has(def.key) && !person.values[def.key]?.v) { it.na = true; return; }
  const r = render(SES.ent, it.key, it.as, fieldOf(it));
  it.missing = !!r.missing; it.value = r.value; it.show = r.show || ''; it.problem = r.problem || '';
}

/** Where a freshly matched item starts: filled and green, filled and amber, or listed. */
function settle(it) {
  evaluate(it);
  if (!it.key || it.na) it.status = 'empty';
  else if (it.missing) it.status = 'missing';
  else if (it.conf === 'low') it.status = 'suggest';
  else if (it.problem || it.conf === 'medium' || it.note) it.status = 'check';
  else it.status = 'ok';
}

const canApply = it => !!it.key && !it.missing && (it.status === 'ok' || it.status === 'check') && !(it.problem && (it.value === '' || it.value == null));

function apply(it) {
  const want = canApply(it);
  if (SES.kind === 'pdf') {
    const d = SES.doc;
    if (want) d.values[it.name] = it.value; else if (it.applied) delete d.values[it.name];
  } else if (SES.kind === 'flat') applyFlat(it, want);
  if (want !== it.applied || want) SES.changed = true;
  it.applied = want;
}

function applyFlat(it, want) {
  const line = it.target;
  const remove = () => { if (it.itemId) { C.text.remove(it.itemId); it.itemId = null; } };
  if (!want || (it.place === 'mark' && !it.value)) return remove();
  if (it.place === 'mark') {
    // Re-place a tick every time: which box gets it depends on the value.
    remove();
    const opt = it.option === '@yesno' ? yesNoOption(line, rawValue(SES.ent, it.key)) : it.option;
    const pos = it.pos || (opt && line.segs ? placeOnLine(line, { ...it, option: opt }, null) : null);
    if (!pos) return;
    it.itemId = C.text.place(SES.doc, [{ page: line.page - 1, x: pos.x, y: pos.y, size: pos.size, text: 'X', kyc: true }])[0];
    return;
  }
  const text = it.show;
  if (it.itemId && C.text.has(it.itemId)) { C.text.update(it.itemId, { text: wrap(text, C.text.pos(it.itemId), SES.doc, line.page - 1) }); return; }
  const pos = it.pos || (line.segs ? placeOnLine(line, it, null) : null); if (!pos) return;
  it.itemId = C.text.place(SES.doc, [{ page: line.page - 1, x: pos.x, y: pos.y, size: pos.size, text: wrap(text, pos, SES.doc, line.page - 1), kyc: true }])[0];
}

function wrap(text, pos, doc, pageIdx) {
  if (!pos || (!text.includes('\n') && text.length < 60)) return text;
  let Wd = 595; try { Wd = doc.proxies[pageIdx].getViewport({ scale: 1 }).viewBox[2]; } catch {}
  const max = Math.max(20, Math.floor((Wd - pos.x - 36) / (pos.size * 0.5)));
  return text.split('\n').map(par => { const out = []; let line = ''; for (const w of par.split(/\s+/)) { if ((line + ' ' + w).trim().length > max) { if (line) out.push(line); line = w; } else line = (line + ' ' + w).trim(); } if (line) out.push(line); return out.join('\n'); }).join('\n');
}

function clearApplied(ses) {
  for (const it of ses.items) {
    if (!it.applied) continue;
    if (ses.kind === 'pdf') delete ses.doc.values[it.name];
    else if (ses.kind === 'flat' && it.itemId) C.text.remove(it.itemId);
  }
}

/** Pick up profile edits and undo: re-read values, and notice answers removed from the page. */
function sync() {
  for (const it of SES.items) {
    // Undo removes answers; redo brings them back with the same field or item.
    const present = SES.kind === 'pdf' ? it.name in SES.doc.values : SES.kind === 'flat' ? !!it.itemId && C.text.has(it.itemId) : true;
    if (it.applied && !present) { it.undone = it.status; it.applied = false; it.status = 'suggest'; }
    else if (!it.applied && it.undone && present) { it.applied = true; it.status = it.undone; it.undone = null; }
    if (!it.key) continue;
    const before = [it.value, it.missing];
    evaluate(it);
    if (it.status === 'missing' && !it.missing) { it.status = it.conf === 'low' ? 'suggest' : 'ok'; apply(it); }
    else if (it.status !== 'missing' && it.missing) { it.status = 'missing'; apply(it); }
    else if (it.applied && before[0] !== it.value) apply(it);
  }
}

// ================================================================ actions
function refresh() {
  if (!SES) return;
  if (SES.kind === 'office') { drawSide(); schedulePreview(); return; }
  C.redrawDoc(SES.doc);
  if (C.S.itab === 'form') C.renderInsp();
}

function select(it, reveal = true) {
  SES.sel = it.n; SES.picking = null;
  if (it.status === 'ok') SES.open.filled = true;
  if (it.status === 'empty') SES.open.empty = true;
  if (reveal) revealItem(it);
  refresh();
}

function revealItem(it) {
  if (SES.kind === 'pdf') {
    const f = SES.doc.fields.find(x => x.name === it.name); const w = f?.widgets?.[0];
    if (w) C.revealRect(SES.doc, w.page, w.rect);
  } else if (SES.kind === 'flat') {
    if (it.itemId && C.text.has(it.itemId)) C.text.select(it.itemId);
    else if (it.target.segs) C.revealRect(SES.doc, it.target.page - 1, [it.target.x0, it.target.y, 10, it.target.size]);
  } else {
    const el = document.querySelector(`.kfo-doc [data-n="${it.n}"]`) || (it.name && document.querySelector(`.kfo-doc [data-slot="${CSS.escape(it.name)}"]`));
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function pickField(docId, name) {
  if (!SES || SES.kind !== 'pdf' || SES.doc.id !== docId) { C.setTab('form'); return; }
  const it = SES.byName.get(name); if (!it) return;
  C.S.itab = 'form';
  select(it, false);
}

function confirmIt(it) { it.undone = null; it.status = 'ok'; it.conf = 'you'; it.touched = true; apply(it); refresh(); }
function clearIt(it) { it.undone = null; it.key = null; it.status = 'empty'; it.touched = true; it.note = ''; apply(it); refresh(); }
function useIt(it) { it.undone = null; it.status = it.problem ? 'check' : 'ok'; it.conf = 'you'; it.touched = true; apply(it); refresh(); }

function choose(it, key) {
  it.key = key; it.touched = true; it.conf = 'you'; it.source = 'you'; it.note = '';
  if (SES.kind === 'flat') { if (!it.place) it.place = 'right'; if (!it.label) it.label = lineLabel(it.target.text || ''); }
  it.as = autoAs(SES.ent, key, fieldOf(it));
  evaluate(it);
  it.status = it.missing ? 'missing' : it.problem ? 'check' : 'ok';
  SES.picking = null; apply(it); refresh();
}

/** Typing a missing value here saves it to the profile, then fills every field that uses it. */
function saveMissing(it, v) {
  const def = keyDef(SES.ent, it.key); if (!def) return;
  const bag = def.scope === 'person' ? peopleIn(SES.ent, def.role)[def.n - 1]?.values : SES.ent.values;
  if (!bag) return;
  setValue(bag, def, v);
  sync(); refresh();
  C.toast(`Saved to your profile: ${keyLabel(SES.ent, it.key)}.`);
}
function addPerson(role) {
  const ent = SES.ent;
  ent.people.push({ id: crypto.randomUUID(), kind: 'person', roles: [role], values: {}, order: Math.max(-1, ...ent.people.map(p => p.order ?? 0)) + 1, since: todayIso() });
  persist(); sync(); refresh();
}

// ================================================================ Claude on what's left
async function runClaude() {
  const ses = SES;
  const info = await refreshInfo().catch(() => ({}));
  const open = ses.items.filter(it => it.status === 'empty' && !it.touched && !it.na);
  if (!open.length) return;
  if (!info.has_key || K.P.settings.useClaude === false) { ses.claude = { state: 'off', left: open.length }; refresh(); return; }
  ses.claude = { state: 'running', left: open.length }; refresh();
  try {
    const avoid = [ses.counterparty];
    const { matches } = ses.kind === 'flat' ? await claudeMatch(ses.ent, { lines: open.map(it => it.target), avoid }) : await claudeMatch(ses.ent, { fields: open.map(it => it.target), avoid });
    if (SES !== ses) return;
    let n = 0;
    for (const m of matches) {
      if (!m.key) continue;
      let it = ses.items.find(i => i.target.id === m.id && i.status === 'empty' && !i.touched);
      if (!it && ses.kind === 'flat' && m.place === 'mark') {
        const line = ses.items.find(i => i.target.id === m.id)?.target; if (!line) continue;
        it = addItem(line, null);
      }
      if (!it) continue;
      Object.assign(it, { key: m.key, as: m.as || autoAs(ses.ent, m.key, fieldOf(it)), conf: m.confidence, note: m.note, source: 'claude' });
      if (ses.kind === 'flat') Object.assign(it, { place: m.place || 'right', option: m.option, label: m.label || lineLabel(it.target.text) });
      settle(it); apply(it); n++;
    }
    ses.claude = { state: 'done', got: n, left: open.length };
  } catch (e) {
    if (SES !== ses) return;
    ses.claude = { state: 'error', msg: errKind(e) === 'NOKEY' ? errMsg(e) : 'Claude matching failed: ' + errMsg(e) };
  }
  refresh();
}

async function showSent() {
  const { h, modal } = C;
  const open = SES.items.filter(it => it.status === 'empty' && !it.touched).map(it => it.target);
  if (!open.length) { C.toast('Nothing left for Claude: every spot is matched or cleared.'); return; }
  try {
    const req = claudeRequest(SES.ent, SES.kind === 'flat' ? { lines: open, avoid: [SES.counterparty] } : { fields: open.slice(0, 140), avoid: [SES.counterparty] });
    const [text, removed] = await V.preview(req);
    const pre = h('pre', { class: 'rv-pre' }); pre.textContent = text;
    const m = modal('What gets sent', h('p', { class: 'hint' }, `The exact request for the ${open.length} spot${open.length > 1 ? 's' : ''} Proof couldn’t match itself. ${removed ? `${removed} bit${removed > 1 ? 's' : ''} were masked or cut.` : 'Nothing needed masking.'}`), pre,
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => m.close() }, 'Close')));
    m.modal.classList.add('wide');
  } catch (e) { C.toast(errMsg(e), 6000); }
}

// ================================================================ the side list
export function keyOptions(ent) {
  const out = [];
  for (const d of [...entityKeys(ent), ...SPECIAL_KEYS]) out.push([d.label, d.key]);
  for (const r of ROLES) {
    const n = Math.min(8, Math.max(peopleIn(ent, r.role).length, r.role === 'shareholder' ? 0 : 1) + 1);
    for (let i = 1; i <= n; i++) for (const d of personKeys(ent)) out.push([`${r.label} ${i} · ${d.label}`, `${r.role}.${i}.${d.key}`]);
  }
  return out;
}

const itemLabel = it => {
  if (SES.kind === 'flat') { const l = it.label || lineLabel(it.target.text || '') || it.target.text || 'Saved spot'; return it.place === 'mark' && it.option && it.option !== '@yesno' ? `${l} → ${it.option}` : l; }
  return fieldLabel(it.target) || it.name;
};

function panel() {
  const { h } = C; const ses = SES; const ent = ses.ent;
  sync();
  const by = s => ses.items.filter(i => i.status === s);
  const filled = ses.items.filter(i => i.applied);
  const check = by('check').filter(i => i.applied || i.problem), missing = by('missing'), suggest = by('suggest'), empty = by('empty');
  const ok = filled.filter(i => i.status === 'ok');
  const opts = keyOptions(ent); const byLabel = new Map(opts);
  const wrapEl = h('div', { class: 'fp' }, h('datalist', { id: 'fp-keys' }, opts.map(([l]) => h('option', { value: l }))));

  // header
  const entSel = K.P.entities.length > 1 ? h('select', { 'aria-label': 'Entity' }, K.P.entities.map(e => h('option', { value: e.id }, e.name))) : null;
  if (entSel) { entSel.value = ent.id; entSel.onchange = () => { const e = K.P.entities.find(x => x.id === entSel.value); setCurEntity(e.id); ses.kind === 'office' ? startOffice(ses.entry, e) : startPdf(ses.doc, e); }; }
  wrapEl.append(h('div', { class: 'fp-h' },
    h('h3', {}, 'Fill from profile'),
    entSel || h('p', { class: 'hint' }, `As ${ent.name}`),
    h('div', { class: 'fp-sum' },
      h('span', { class: 'n ok' }, String(filled.length)), ' filled',
      check.length ? [' · ', h('span', { class: 'n check' }, String(check.length)), ' to check'] : null,
      missing.length ? [' · ', h('span', { class: 'n miss' }, String(missing.length)), ' not in profile'] : null),
    ses.saved ? h('p', { class: 'hint' }, `Recognised form, last filled ${fmtDate(ses.saved.updated)}.`) : null));

  const cl = ses.claude;
  if (cl.state === 'running') wrapEl.append(h('p', { class: 'fp-cl' }, `Asking Claude about ${cl.left} more spot${cl.left > 1 ? 's' : ''} (labels only)…`));
  else if (cl.state === 'done') wrapEl.append(h('p', { class: 'fp-cl' }, cl.got ? `Claude matched ${cl.got} of ${cl.left}.` : `Claude found nothing for the ${cl.left} remaining.`, ' ', h('button', { class: 'lnk', onclick: showSent }, 'What was sent?')));
  else if (cl.state === 'error') wrapEl.append(h('p', { class: 'fp-cl err' }, cl.msg, ' ', h('button', { class: 'lnk', onclick: () => runClaude() }, 'Retry')));
  else if (cl.state === 'off' && K.P.settings.useClaude !== false) wrapEl.append(h('p', { class: 'fp-cl' }, `${cl.left} spot${cl.left > 1 ? 's' : ''} left. `, h('button', { class: 'lnk', onclick: () => openProfile('settings') }, 'Add an API key'), ' to let Claude match them.'));

  const group = (title, items, cls) => items.length ? h('section', { class: 'fp-g ' + cls }, h('h4', {}, title, h('b', {}, String(items.length))), items.map(card)) : null;
  const fold = (key, title, items) => {
    if (!items.length) return null;
    const d = h('details', { class: 'fp-g fold', open: !!ses.open[key] }, h('summary', {}, title, h('b', {}, String(items.length))), items.map(card));
    d.addEventListener('toggle', () => (ses.open[key] = d.open));
    return d;
  };
  wrapEl.append(...[
    group('To check', check, 'check'),
    group('Not in your profile', missing, 'miss'),
    group('Maybe', suggest, 'sugg'),
    !check.length && !missing.length && !suggest.length ? h('p', { class: 'fp-done' }, filled.length ? 'Nothing needs you. Look over the pages, then save.' : 'Proof didn’t find anything to fill.') : null,
    fold('filled', 'Filled', ok),
    fold('empty', ses.kind === 'flat' ? 'Lines left empty' : 'Left empty', empty)].filter(Boolean));

  wrapEl.append(h('div', { class: 'fp-f' },
    ses.kind === 'office'
      ? h('button', { class: 'btn primary', onclick: saveOffice }, 'Save filled copy…')
      : h('p', { class: 'hint' }, 'Save as usual (Ctrl+S). Proof asks who it’s for once, keeps a record and learns the labels.'),
    h('div', { class: 'btns' }, h('button', { class: 'btn quiet', onclick: attachDocs }, 'Attach documents…'), h('button', { class: 'btn quiet', onclick: () => openProfile() }, 'Profile'))));

  function card(it) {
    const sel = ses.sel === it.n;
    const el = h('div', { class: `fc st-${it.status}${sel ? ' sel' : ''}`, 'data-n': it.n });
    el.append(h('button', { class: 'fc-l', title: 'Show on the form', onclick: () => select(it) }, itemLabel(it)));
    if (it.key) el.append(h('div', { class: 'fc-k' }, keyLabel(ent, it.key) + (it.na ? ' · doesn’t apply to a company' : '')));
    if (it.status === 'missing') el.append(missingBox(it));
    else if (it.key) el.append(h('div', { class: 'fc-a' }, it.show || '—'));
    for (const t of [it.problem, it.note]) if (t) el.append(h('div', { class: 'fc-n' }, t));
    if (ses.picking === it.n) {
      const inp = h('input', { type: 'text', list: 'fp-keys', placeholder: 'Type to find a profile item', spellcheck: 'false', 'aria-label': 'Profile item' });
      inp.addEventListener('change', () => { const k = byLabel.get(inp.value.trim()); if (k) choose(it, k); else inp.classList.add('bad'); });
      inp.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); ses.picking = null; refresh(); } });
      el.append(h('div', { class: 'fc-p' }, inp, h('button', { class: 'btn quiet', onclick: () => { ses.picking = null; refresh(); } }, 'Cancel')));
      requestAnimationFrame(() => inp.focus());
    } else {
      const b = (label, fn, cls = '') => h('button', { class: 'btn ' + cls, onclick: fn }, label);
      const change = b(it.key ? 'Change' : 'Choose item', () => { ses.sel = it.n; ses.picking = it.n; refresh(); }, 'quiet');
      const acts = {
        check: [it.applied ? b('Looks right', () => confirmIt(it)) : null, change, b('Clear', () => clearIt(it), 'quiet')],
        suggest: [b('Use', () => useIt(it)), change, b('No', () => clearIt(it), 'quiet')],
        missing: [change, b('Skip', () => clearIt(it), 'quiet')],
        ok: sel ? [change, b('Clear', () => clearIt(it), 'quiet')] : [],
        empty: [change],
      }[it.status] || [];
      if (acts.some(Boolean)) el.append(h('div', { class: 'fc-b' }, acts));
    }
    return el;
  }

  function missingBox(it) {
    const def = keyDef(ent, it.key);
    if (it.missingWhy) {
      const have = peopleIn(ent, def.role).length;
      return h('div', { class: 'fc-in' }, h('span', { class: 'fc-n' }, it.missingWhy),
        def.n === have + 1 ? h('button', { class: 'btn', onclick: () => addPerson(def.role) }, `Add ${roleInfo(def.role).label} ${def.n}`) : null);
    }
    return valueInput(def, v => saveMissing(it, v));
  }
  return wrapEl;
}

function valueInput(def, onSet) {
  const { h } = C; let el;
  if (def.kind === 'date') el = h('input', { type: 'date' });
  else if (def.kind === 'country') el = h('select', {}, h('option', { value: '' }, 'Choose…'), COUNTRIES.map(([c, , n]) => h('option', { value: c }, n)));
  else if (def.kind === 'bool') el = h('select', {}, h('option', { value: '' }, 'Choose…'), h('option', { value: 'yes' }, 'Yes'), h('option', { value: 'no' }, 'No'));
  else if (def.kind === 'choice') el = h('select', {}, h('option', { value: '' }, 'Choose…'), def.choices.map(c => h('option', { value: c }, c)));
  else if (def.kind === 'longtext') el = h('textarea', { rows: '3' });
  else el = h('input', { type: 'text', spellcheck: 'false', placeholder: 'Saved to your profile' });
  el.setAttribute('aria-label', def.label);
  const go = () => { const v = (el.value || '').trim(); if (v) onSet(v); };
  const instant = el.tagName === 'SELECT' || el.type === 'date';
  if (instant) el.addEventListener('change', go);
  else el.addEventListener('keydown', e => { if (e.key === 'Enter' && (el.tagName !== 'TEXTAREA' || e.ctrlKey)) { e.preventDefault(); go(); } });
  return h('div', { class: 'fc-in' }, el, instant ? null : h('button', { class: 'btn', onclick: go }, 'Save'));
}

const fmtDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : iso || ''; };

function summaryToast() {
  const f = SES.items.filter(i => i.applied).length, c = SES.items.filter(i => i.status === 'check' || i.status === 'missing' || i.status === 'suggest').length;
  C.toast(f ? `Filled ${f}.${c ? ` ${c} need${c === 1 ? 's' : ''} you, listed on the right.` : ' Nothing needs you.'}` : 'Nothing matched yet.', 4500);
}

// ================================================================ marks on PDF pages
const ST_CLASS = { ok: 'ok', check: 'check', suggest: 'sugg', missing: 'miss', empty: 'none' };

function drawMarks(p, v) {
  const d = p.doc; if (!d.fields?.length || !v?.vp) return;
  const ses = SES && SES.kind === 'pdf' && SES.doc === d ? SES : null;
  const vp = v.vp, sc = vp.scale;
  for (const f of d.fields) {
    const ws = (f.widgets || []).filter(w => w.page === p.idx); if (!ws.length) continue;
    const has = f.name in d.values, val = d.values[f.name];
    const it = ses?.byName.get(f.name);
    if (!it && (!has || val === '' || val === false)) continue;
    const cls = it ? (it.applied ? ST_CLASS[it.status] : ST_CLASS[it.status] + ' open') : 'man';
    ws.forEach((w, wi) => {
      const [x, y, wd, ht] = w.rect;
      const a = vp.convertToViewportPoint(x, y), b = vp.convertToViewportPoint(x + wd, y + ht);
      const L = Math.min(a[0], b[0]), T = Math.min(a[1], b[1]), Wd = Math.abs(a[0] - b[0]), Ht = Math.abs(a[1] - b[1]);
      const el = document.createElement('div');
      el.className = 'kf ' + cls + (ses && it && ses.sel === it.n ? ' sel' : '');
      el.dataset.doc = d.id; el.dataset.name = f.name;
      el.style.cssText = `left:${L}px;top:${T}px;width:${Wd}px;height:${Ht}px`;
      if (has) {
        if (f.kind === 'check') { el.classList.add('box'); if (val) el.textContent = '✓'; el.style.fontSize = Math.min(Ht, Wd) * 0.9 + 'px'; }
        else if (f.kind === 'radio') { el.classList.add('box'); if (f.options?.[wi] === val) el.textContent = '●'; el.style.fontSize = Math.min(Ht, Wd) * 0.7 + 'px'; }
        else {
          el.textContent = String(val ?? '');
          const fs = Math.min(Ht * 0.68, 11 * sc);
          el.style.fontSize = fs + 'px';
          if (f.multi || Ht > fs * 2.6) el.classList.add('multi');
        }
      }
      el.title = it ? `${keyLabel(SES.ent, it.key) || 'Not filled'}. Click to change.` : 'Filled by hand';
      v.layer.append(el);
    });
  }
}

// ================================================================ save: who it's for, record, learn
function askCounterparty(ses) {
  const { h, modal } = C;
  return new Promise(resolve => {
    const inp = h('input', { type: 'text', id: 'cp-in', placeholder: 'e.g. ABN AMRO Clearing', value: ses.counterparty || '' });
    const m = modal('Who is this for?',
      h('p', { class: 'hint' }, 'For your fill record. Asked once per form.'),
      h('label', { class: 'fld', for: 'cp-in' }, h('span', { class: 'lbl' }, 'Counterparty'), inp),
      h('div', { class: 'actions' }, h('button', { class: 'btn quiet', onclick: () => { m.close(); resolve(''); } }, 'Skip'), h('button', { class: 'btn primary', onclick: ok }, 'Continue')));
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
    m.scrim.addEventListener('cancel', () => resolve(null));
    function ok() { m.close(); resolve(inp.value.trim()); }
  });
}

async function beforeSave() {
  const ses = SES;
  if (!ses || ses.kind === 'office' || !C.S.docs.includes(ses.doc) || !ses.changed) return true;
  if (!ses.asked) { const cp = await askCounterparty(ses); if (cp === null) return false; ses.counterparty = cp; ses.asked = true; }
  record(ses);
  return true;
}

function record(ses) {
  const ent = ses.ent;
  const used = ses.items.filter(i => i.applied && i.key);
  const fields = used.map(i => { const d = keyDef(ent, i.key); return { label: String(itemLabel(i)).slice(0, 160), key: i.key, value: String(i.show), ...(d && ENUM_KINDS.has(d.kind) ? { e: true } : {}) }; });
  // Remember the form.
  let entries;
  if (ses.kind === 'flat') {
    entries = used.map(i => { const pos = i.itemId ? C.text.pos(i.itemId) : null; return pos ? { key: i.key, as: i.as, page: pos.page + 1, x: pos.x, y: pos.y, size: pos.size, lineText: i.target.text || '', ...(i.place === 'mark' ? { mark: true } : {}) } : null; }).filter(Boolean);
  } else {
    entries = {};
    for (const i of used) entries[i.name] = { key: i.key, as: i.as };
    for (const i of ses.items) if (i.touched && !i.key) entries[i.name] = { skip: true };
  }
  K.P.mappings[ses.fp] = { title: ses.kind === 'office' ? ses.entry.name : ses.doc.name, kind: ses.kind === 'office' ? ses.od.kind : ses.kind === 'flat' ? 'flat' : 'acro', updated: todayIso(), entries };
  // Teach the library what you kept: confident answers and the ones you confirmed or chose.
  for (const i of used) {
    if (i.status !== 'ok') continue;
    if (ses.kind === 'flat') { if (i.place !== 'mark' && i.target.text) learn(i.label || lineLabel(i.target.text), i.key, i.as, 'text'); }
    else learn(libLabel(i.target), i.key, i.as, i.target.kind);
  }
  const file = ses.kind === 'office' ? ses.entry.name : ses.doc.name;
  if (ses.logEntry && K.P.log.includes(ses.logEntry)) Object.assign(ses.logEntry, { at: new Date().toISOString(), fields, counterparty: ses.counterparty });
  else { ses.logEntry = { at: new Date().toISOString(), entity: ent.id, counterparty: ses.counterparty, file, fp: ses.fp, fields }; K.P.log.unshift(ses.logEntry); if (K.P.log.length > 5000) K.P.log.length = 5000; }
  ses.changed = false;
  persist();
}

// ================================================================ Word and Excel: own view with preview
let ov = null, previewT = null;

function openOfficeView() {
  const { h } = C;
  closeOfficeView(true);
  ov = h('div', { class: 'kfo', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Fill from profile' });
  ov.append(
    h('header', { class: 'kh' }, h('h1', {}, 'Fill'), h('span', { class: 'kfo-file', title: SES.entry.path || SES.entry.name }, SES.entry.name), h('span', { class: 'sp' }),
      h('span', { class: 'kstate' }, SES.od.kind === 'xlsx' ? 'Excel · answers go into a copy' : 'Word · answers go into a copy'),
      h('button', { class: 'tbtn', onclick: () => closeOfficeView() }, 'Close')),
    h('main', { class: 'kfo-doc' }, h('div', { class: SES.od.kind === 'xlsx' ? 'kfo-sheets' : 'kfo-paper' }, h('p', { class: 'hint' }, 'Rendering…'))),
    h('aside', { class: 'kfo-side' }));
  ov.querySelector('.kfo-doc').addEventListener('click', e => {
    const t = e.target.closest('[data-n],[data-slot]'); if (!t || !SES) return;
    const it = t.dataset.n != null ? SES.items[+t.dataset.n] : SES.byName.get(t.dataset.slot);
    if (it) select(it, false);
  });
  document.body.append(ov);
  document.addEventListener('keydown', ovKeys, true);
  drawSide(); renderPreview();
}
function ovKeys(e) { if (e.key === 'Escape' && ov && !document.querySelector('.scrim')) { e.stopPropagation(); closeOfficeView(); } }

function closeOfficeView(force = false) {
  if (!ov) return;
  if (!force && SES?.kind === 'office' && SES.changed) {
    const { h, modal } = C;
    const m = modal('Close without saving?', h('p', {}, 'The filled copy hasn’t been saved since your last change.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn quiet', onclick: () => m.close() }, 'Keep filling'), h('button', { class: 'btn danger', onclick: () => { m.close(); closeOfficeView(true); } }, 'Close')));
    return;
  }
  ov.remove(); ov = null; document.removeEventListener('keydown', ovKeys, true);
  if (SES?.kind === 'office') SES = null;
}

function drawSide() {
  if (!ov || !SES) return;
  const side = ov.querySelector('.kfo-side'); const top = side.scrollTop;
  side.replaceChildren(panel()); side.scrollTop = top;
  side.querySelector('.fc.sel')?.scrollIntoView({ block: 'nearest' });
}

function schedulePreview() { clearTimeout(previewT); previewT = setTimeout(renderPreview, 150); }

/** Values to write. For the preview, text answers are wrapped in markers so they can be highlighted. */
function officeValues(marked) {
  const values = new Map();
  for (const it of SES.items) {
    if (!it.applied) continue;
    let v = it.value; const kind = it.target.kind;
    if (typeof v === 'boolean' && kind !== 'check') { if (!v) continue; v = 'X'; }
    if (!marked && SES.od.kind === 'xlsx' && keyDef(SES.ent, it.key)?.kind === 'number' && /^-?\d+(\.\d+)?$/.test(String(v))) v = Number(v);
    if (marked && (kind === 'text' || (kind === 'select' && /^Content control/.test(it.target.where || '')))) v = '\uE000' + it.n + '\uE001' + v + '\uE002';
    values.set(it.name, v);
  }
  return values;
}

async function renderPreview() {
  if (!ov || !SES) return;
  const ses = SES; const host_ = ov.querySelector('.kfo-doc > div');
  try {
    const bytes = await (await loadOffice(ses.entry.bytes, ses.entry.name)).save(officeValues(true));
    const out = await loadOffice(bytes, ses.entry.name);
    if (SES !== ses || !ov) return;
    const doc = ov.querySelector('.kfo-doc'); const top = doc.scrollTop;
    host_.replaceChildren(ses.od.kind === 'xlsx' ? sheetHtml(out) : wordHtml(out.dom));
    markSpans(host_);
    doc.scrollTop = top;
  } catch (e) { host_.replaceChildren(C.h('p', { class: 'msg' }, 'Couldn’t render a preview: ' + (e?.message || e))); }
}

/** Turn the markers around written answers into highlighted, clickable spans. */
function markSpans(root) {
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const nodes = [];
  while (tw.nextNode()) nodes.push(tw.currentNode);
  let open = null;
  for (const t of nodes) {
    const s = t.nodeValue; if (open == null && !s.includes('\uE000')) continue;
    const frag = document.createDocumentFragment(); let buf = '';
    const flush = () => {
      if (!buf) return;
      if (open != null) { const it = SES.items[+open]; const sp = document.createElement('span'); sp.className = `kv ${ST_CLASS[it?.status] || 'ok'}${SES.sel === +open ? ' sel' : ''}`; sp.dataset.n = open; sp.textContent = buf; frag.append(sp); }
      else frag.append(buf);
      buf = '';
    };
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\uE000') { flush(); const j = s.indexOf('\uE001', i); open = s.slice(i + 1, j); i = j; }
      else if (c === '\uE002') { flush(); open = null; }
      else buf += c;
    }
    flush(); t.replaceWith(frag);
  }
}

// ---- Word: a plain rendering of paragraphs and tables, enough to check answers in place
const WN = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const wk = (n, name) => n ? [...n.children].find(c => c.namespaceURI === WN && c.localName === name) || null : null;
const wa = (n, name) => n?.getAttributeNS(WN, name) ?? n?.getAttribute('w:' + name) ?? null;
const off = v => /^(0|false|none|off)$/i.test(v || '');

function wordHtml(dom) {
  const out = document.createElement('div'); out.className = 'wd';
  block(wk(dom.documentElement, 'body'), out);
  return out;
}
function block(node, out) {
  for (const c of node?.children || []) {
    if (c.namespaceURI !== WN) continue;
    if (c.localName === 'p') out.append(para(c));
    else if (c.localName === 'tbl') out.append(table(c));
    else if (c.localName === 'sdt') block(wk(c, 'sdtContent'), out);
    else if (c.localName === 'customXml' || c.localName === 'ins') block(c, out);
  }
}
function para(p) {
  const st = wa(wk(wk(p, 'pPr'), 'pStyle'), 'val') || '';
  const el = document.createElement('p');
  const lvl = /title/i.test(st) ? 't' : (/heading\s*(\d)/i.exec(st) || /kop\s*(\d)/i.exec(st) || [])[1];
  el.className = 'wp' + (lvl ? ' wh' + lvl : '');
  inline(p, el);
  if (!el.textContent.trim() && !el.querySelector('br')) el.append(' ');
  return el;
}
function inline(node, el) {
  for (const c of node?.children || []) {
    if (c.namespaceURI !== WN) continue;
    if (c.localName === 'r') run(c, el);
    else if (c.localName === 'sdt') inline(wk(c, 'sdtContent'), el);
    else if (['hyperlink', 'smartTag', 'ins', 'fldSimple', 'customXml', 'sdtContent', 'bdo', 'dir'].includes(c.localName)) inline(c, el);
  }
}
function run(r, el) {
  const rPr = wk(r, 'rPr'); const on = n => { const x = wk(rPr, n); return !!x && !off(wa(x, 'val')); };
  const sp = document.createElement('span');
  if (on('b')) sp.style.fontWeight = '700';
  if (on('i')) sp.style.fontStyle = 'italic';
  if (on('u')) sp.style.textDecoration = 'underline';
  for (const c of r.children) {
    if (c.namespaceURI !== WN) continue;
    const n = c.localName;
    if (n === 't') sp.append(c.textContent);
    else if (n === 'tab' || n === 'ptab') sp.append('  ');
    else if (n === 'br' || n === 'cr') sp.append(document.createElement('br'));
    else if (n === 'noBreakHyphen') sp.append('-');
    else if (n === 'sym') { const ch = (wa(c, 'char') || '').toUpperCase(); sp.append(['F0FD', 'F0FE', 'F078'].includes(ch) ? '☒' : ['F06F', 'F0A8', 'F071', 'F072', 'F0A1'].includes(ch) ? '☐' : ''); }
    else if (n === 'fldChar') {
      const cb = wk(wk(c, 'ffData'), 'checkBox');
      if (cb) { const chk = wk(cb, 'checked') || wk(cb, 'default'); sp.append(chk && !(wk(cb, 'checked') ? off(wa(chk, 'val')) : off(wa(chk, 'val') ?? '0')) ? '☒' : '☐'); }
    }
  }
  el.append(sp);
}
function table(tbl) {
  const t = document.createElement('table'); t.className = 'wt';
  for (const tr of tbl.children) {
    if (tr.namespaceURI !== WN || tr.localName !== 'tr') continue;
    const row = t.insertRow();
    for (const tc of tr.children) {
      if (tc.namespaceURI !== WN || tc.localName !== 'tc') continue;
      const td = row.insertCell(); const pr = wk(tc, 'tcPr');
      const span = wk(pr, 'gridSpan'); if (span) td.colSpan = +wa(span, 'val') || 1;
      const vm = wk(pr, 'vMerge'); if (vm && wa(vm, 'val') !== 'restart') td.classList.add('vm');
      block(tc, td);
    }
  }
  return t;
}

// ---- Excel: the used part of each visible sheet, answer spots outlined
const colName = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
function sheetHtml(out) {
  const wrapEl = document.createElement('div'); wrapEl.className = 'xs';
  const slotAt = new Map(SES.od.slots.map(s => [s.name, s]));
  for (const sh of out.sheets) {
    if (sh.state !== 'visible') continue;
    let maxR = 1, maxC = 1;
    for (const c of sh.cells.values()) if (c.text) { maxR = Math.max(maxR, c.row); maxC = Math.max(maxC, c.col); }
    for (const s of SES.od.slots) { const m = new RegExp('^' + sh.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '!([A-Z]+)(\\d+)$').exec(s.name); if (m) { maxR = Math.max(maxR, +m[2]); maxC = Math.max(maxC, m[1].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)); } }
    maxR = Math.min(maxR + 1, 400); maxC = Math.min(maxC + 1, 40);
    const cover = new Map(); for (const m of sh.merges) for (const [c, r] of m.cells) cover.set(c + ',' + r, m);
    const t = document.createElement('table'); t.className = 'xt';
    const hr = t.insertRow(); hr.insertCell().className = 'xh';
    for (let c = 1; c <= maxC; c++) { const th = hr.insertCell(); th.className = 'xh'; th.textContent = colName(c); }
    for (let r = 1; r <= maxR; r++) {
      if (sh.hiddenRows.has(r)) continue;
      const row = t.insertRow(); const rh = row.insertCell(); rh.className = 'xh'; rh.textContent = r;
      for (let c = 1; c <= maxC; c++) {
        const m = cover.get(c + ',' + r);
        if (m && (m.tl[0] !== c || m.tl[1] !== r)) continue;
        const td = row.insertCell();
        if (m) { td.colSpan = m.br[0] - m.tl[0] + 1; td.rowSpan = m.br[1] - m.tl[1] + 1; }
        td.textContent = sh.cells.get(c + ',' + r)?.text || '';
        const name = `${sh.name}!${colName(c)}${r}`;
        const it = slotAt.has(name) ? SES.byName.get(name) : null;
        if (it) { td.dataset.slot = name; td.classList.add('slot', ST_CLASS[it.status]); if (it.applied) td.classList.add('on'); if (SES.sel === it.n) td.classList.add('sel'); }
      }
    }
    wrapEl.append(Object.assign(document.createElement('h4'), { textContent: sh.name }), t);
  }
  return wrapEl;
}

async function saveOffice() {
  const ses = SES;
  if (!ses.items.some(i => i.applied)) { C.toast('Nothing filled yet.'); return; }
  if (!ses.asked) { const cp = await askCounterparty(ses); if (cp === null) return; ses.counterparty = cp; ses.asked = true; }
  const name = ses.entry.name;
  const ext = ses.od.kind === 'xlsx' ? (/\.xlsm$/i.test(name) ? 'xlsm' : 'xlsx') : (/\.docm$/i.test(name) ? 'docm' : 'docx');
  const stem = name.replace(/\.[^.]+$/, '');
  const def = (ses.entry.path ? host.joinPath(host.dirName(ses.entry.path), '') : '') + `${stem} - filled.${ext}`;
  const path = await host.pickSave(def, { name: ses.od.kind === 'xlsx' ? 'Excel workbook' : 'Word document', ext });
  if (!path) return;
  const b = C.busy('Writing…');
  try { const bytes = await (await loadOffice(ses.entry.bytes, name)).save(officeValues(false)); await host.writePath(path, bytes); }
  catch (e) { b.done(); C.toast('Couldn’t save: ' + (e?.message || e), 8000); return; }
  b.done();
  record(ses); drawSide();
  C.toast(`Saved ${path.startsWith('download:') ? path.slice(9) : host.baseName(path)}. The original is untouched.`, 6000);
}

// Build the profile from a form that's already been filled: read each answer, match its label to
// a profile item (the same matching used for filling), turn the answer into the profile's format,
// and show everything for review. Nothing is saved until you press Add.

import * as host from '../host.js';
import { keyDef, keyLabel, roleInfo, ENUM_KINDS } from './schema.js';
import { COUNTRIES } from './countries.js';
import { K, persist, setValue, rawValue, peopleIn, todayIso, refreshInfo, errMsg } from './vault.js';
import { pageLines, describeFields, flatLines, norm } from './extract.js';
import { readAnswers, isOfficeName } from './office.js';
import { localFields, claudeMatch, learn, libLabel, lineLabel, fieldLabel, autoAs } from './match.js';
import { inspect } from '../engine.js';
import { ensureUnlocked, curEntity, pdfDoc, openProfile, renderKyc } from './ui.js';
import { keyOptions } from './fill.js';

let C = null;
export function initHarvest(ctx) { C = ctx; }

// ---------------------------------------------------------------- reading answers from PDFs
async function pdfAnswers(bytes) {
  const doc = await pdfDoc(bytes);
  try {
    const lines = await pageLines(doc);
    const fields = await describeFields(doc, lines);
    const out = [];
    if (fields.length) {
      const { fields: vals } = await inspect(doc.bytes);
      const byName = new Map(vals.map(f => [f.name, f.value]));
      for (const f of fields) {
        const v = byName.get(f.name);
        if (f.kind === 'check') { if (v === true) out.push({ ...f, value: true }); continue; }
        if (typeof v === 'string' && v.trim() && !/^[\s_.]*$/.test(v)) out.push({ ...f, value: v.trim() });
      }
    }
    // Text on the page ("Label: answer"): flat forms, and forms filled by typing on top.
    let section = '';
    for (const l of flatLines(lines)) {
      if (l.heading) { section = l.text; continue; }
      for (const part of l.text.split(/\s{2,}/)) {
        const m = /^([^:]{2,90}):\s*(.+)$/.exec(part.trim());
        if (!m || /^[\s_.…]*$/.test(m[2]) || /_{3,}/.test(m[2])) continue;
        out.push({ kind: 'text', tip: m[1].trim(), left: '', above: '', right: '', inside: '', below: '', nice: '', options: [], page: l.page, section, ctx: [section], value: m[2].replace(/_+$/, '').trim() });
      }
    }
    out.forEach((d, i) => (d.id = 'a' + (i + 1)));
    return out;
  } finally { doc.pdf.destroy?.(); }
}

// ---------------------------------------------------------------- turning answers into profile values
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTHS_NL = ['jan', 'feb', 'maa', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const iso = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1800 && y <= 2200) ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
/** Day first unless the label says month first (MM/DD). Excel stores dates as day counts. */
export function parseDate(t, label = '') {
  t = String(t).trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t); if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})$/.exec(t);
  if (m) { let y = +m[3]; if (y < 100) y += y > 40 ? 1900 : 2000; const us = /mm\s*[\/.-]\s*dd/i.test(label); return us ? iso(y, +m[1], +m[2]) : iso(y, +m[2], +m[1]); }
  m = /^(\d{1,2})\.?\s+([a-zé]+)\.?\s+(\d{4})$/i.exec(t);
  if (m) { const k = m[2].slice(0, 3).toLowerCase(); const mi = Math.max(MONTHS.indexOf(k), MONTHS_NL.indexOf(k)); if (mi >= 0) return iso(+m[3], mi + 1, +m[1]); }
  m = /^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(t);
  if (m) { const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()); if (mi >= 0) return iso(+m[3], mi + 1, +m[2]); }
  if (/^\d{4,5}(\.0+)?$/.test(t) && +t > 1000 && +t < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(+t) * 86400000); return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
  return null;
}
const COUNTRY_ALIASES = { 'the netherlands': 'NL', holland: 'NL', nederland: 'NL', 'netherlands the': 'NL', uk: 'GB', 'great britain': 'GB', england: 'GB', usa: 'US', 'u s a': 'US', 'u s': 'US', 'united states of america': 'US', america: 'US', deutschland: 'DE', belgie: 'BE', 'belgië': 'BE', luxemburg: 'LU', schweiz: 'CH', suisse: 'CH', 'korea': 'KR', 'russia': 'RU', 'uae': 'AE' };
export function parseCountry(t) {
  const n = norm(t); if (!n) return null;
  if (COUNTRY_ALIASES[n]) return COUNTRY_ALIASES[n];
  const r = COUNTRIES.find(([a2, a3, name]) => n === a2.toLowerCase() || n === a3.toLowerCase() || n === norm(name));
  if (r) return r[0];
  const loose = COUNTRIES.filter(([, , name]) => norm(name).length > 4 && (n.includes(norm(name)) || norm(name).includes(n)));
  return loose.length === 1 ? loose[0][0] : null;
}
export function parseBool(t) {
  if (t === true) return 'yes';
  const n = norm(t);
  if (['yes', 'y', 'ja', 'j', 'true', 'x', 'oui', 'si'].includes(n)) return 'yes';
  if (['no', 'n', 'nee', 'false', 'non', 'nein'].includes(n)) return 'no';
  return null;
}

/** The value to store for a matched answer, or null when it can't be read as that item. */
function toStored(def, d, as) {
  const raw = d.value;
  if (d.kind === 'check') {
    if (raw !== true) return null;
    const m = /^check:(!?)(.*)$/.exec(as || '');
    if (m && m[1] && def.kind === 'bool') return m[2] === 'yes' ? 'no' : null;
    if (m && m[2] && def.kind === 'choice') return def.choices.find(c => norm(c) === norm(m[2])) || null;
    if (def.kind === 'bool') return /\b(no|nee|non|nein)\b/i.test(d.right || '') ? 'no' : 'yes';
    if (def.kind === 'choice') return def.choices.find(c => norm(d.right || '').includes(norm(c))) || null;
    return null;
  }
  const t = String(raw ?? '').trim(); if (!t) return null;
  switch (def.kind) {
    case 'date': return parseDate(t, [d.tip, d.left, d.above].join(' '));
    case 'country': return parseCountry(t);
    case 'bool': return parseBool(t);
    case 'choice': return def.choices.find(c => norm(c) === norm(t)) || def.choices.find(c => norm(t).includes(norm(c))) || null;
    case 'number': { const n = t.replace(/[%\s]/g, '').replace(',', '.'); return /^-?\d+(\.\d+)?$/.test(n) ? n : null; }
    default: return t;
  }
}
const COMPANY_RE = /\b(b\.?\s?v\.?|n\.?\s?v\.?|llc|l\.l\.c\.|ltd|limited|inc|incorporated|gmbh|ag|s\.?a\.?|u\.?a\.?|plc|corp|corporation|co[oö]perati[e]?f|holding|holdings|foundation|stichting|trust|fund|partners|lp|llp|sarl|s\.?à\.?r\.?l\.?)\b/i;
const fullNameOf = p => p.values.full_name?.v || [p.values.first_name?.v, p.values.last_name?.v].filter(Boolean).join(' ');
const showVal = (def, v) => def?.kind === 'country' ? (COUNTRIES.find(c => c[0] === v)?.[2] || v) : def?.kind === 'date' ? v.split('-').reverse().join('-') : def?.kind === 'bool' ? (v === 'yes' ? 'Yes' : 'No') : String(v);

// ---------------------------------------------------------------- the flow
export async function harvestForm(ent) {
  if (!(await ensureUnlocked())) return;
  ent ||= curEntity(); if (!ent) return;
  const picked = await host.pickOpen({ multiple: false, title: 'Choose a form you’ve already filled', office: true });
  const f = picked[0]; if (!f) return;
  if (!isOfficeName(f.name) && !/\.pdf$/i.test(f.name)) { C.toast('Use a filled PDF, Word or Excel form.', 6000); return; }
  const b = C.busy('Reading the answers…'); let answers;
  try { answers = isOfficeName(f.name) ? await readAnswers(f.bytes, f.name) : await pdfAnswers(f.bytes); }
  catch (e) { b.done(); C.toast('Couldn’t read that form: ' + (e?.message || e), 8000); return; }
  b.done();
  if (!answers.length) { C.toast(`No answers found in ${f.name}.`, 8000); return; }

  // Match labels to items, on this computer first, then Claude for the rest (labels only, never the answers).
  const props = new Map(localFields(ent, answers).map(p => [p.id, p]));
  const info = await refreshInfo().catch(() => ({}));
  const open = answers.filter(a => !props.get(a.id)?.key);
  let usedClaude = false;
  if (open.length && info.has_key && K.P.settings.useClaude !== false) {
    const bb = C.busy('Asking Claude about the remaining labels…');
    // Hand Claude copies without the answers, so nothing written in the form can travel.
    const bare = open.map(({ value, ...rest }) => rest);
    try { const { matches } = await claudeMatch(ent, { fields: bare, avoid: [] }); for (const m of matches) if (m.key && m.confidence !== 'low') props.set(m.id, m); usedClaude = true; }
    catch (e) { C.toast('Claude matching failed: ' + errMsg(e), 7000); }
    finally { bb.done(); }
  }

  const rows = answers.map(d => {
    const p = props.get(d.id); let key = p?.key || null;
    if (key && !keyDef(ent, key)) key = null;
    if (key === 'today') key = null; // a signing date isn't profile data
    const label = d.kind === 'check' && d.left && d.right ? `${d.left} → ${d.right}` : fieldLabel(d) || '(no label)';
    const r = { d, label, key, as: p?.as || (key ? autoAs(ent, key, d) : ''), conf: p?.confidence || null };
    evaluate(r);
    return r;
  }).filter(r => !(r.d.kind === 'check' && !r.key));
  function evaluate(r) {
    const def = r.key ? keyDef(ent, r.key) : null; r.def = def;
    r.v = def ? toStored(def, r.d, r.as) : null;
    r.cur = '';
    if (def && def.scope !== 'special') {
      if (def.scope === 'person') { const p = peopleIn(ent, def.role)[def.n - 1]; r.cur = p ? (p.values[def.key]?.v || '') : ''; }
      else r.cur = ent.values[def.key]?.v || '';
    }
    r.same = r.v != null && String(r.cur) === String(r.v);
    r.include = !!r.key && r.v != null && !r.same && !r.cur && r.conf !== 'low';
  }
  rows.sort((a, b) => (b.key ? 1 : 0) - (a.key ? 1 : 0));
  review(ent, f.name, rows, usedClaude);
}

function review(ent, fileName, rows, usedClaude) {
  const { h, modal } = C;
  const opts = keyOptions(ent).filter(([, k]) => k !== 'today'); const byLabel = new Map(opts);
  const dl = h('datalist', { id: 'hv-keys' }, opts.map(([l]) => h('option', { value: l })));
  const list = h('div', { class: 'rv-rows hv' });
  const count = h('span', { class: 'rv-count' });
  const add = h('button', { class: 'btn primary', onclick: done }, 'Add');
  const draw = () => {
    const row = r => {
      const cb = h('input', { type: 'checkbox', checked: r.include, disabled: !r.key || r.v == null || r.same, 'aria-label': 'Add this' });
      cb.onchange = () => { r.include = cb.checked; tally(); };
      const it = h('input', { type: 'text', list: 'hv-keys', placeholder: '— not used', spellcheck: 'false', value: r.key ? keyLabel(ent, r.key) : '' });
      it.onchange = () => { const v = it.value.trim(); const k = v ? byLabel.get(v) : null; if (v && !k) { it.classList.add('bad'); return; } r.key = k; r.as = k ? autoAs(ent, k, r.d) : ''; r.conf = 'you'; evaluate(r); if (k && r.v != null && !r.same) r.include = true; draw(); };
      const result = !r.key ? h('span', { class: 'rv-none' }, 'Not used')
        : r.v == null ? h('span', { class: 'rv-miss' }, `Couldn’t read “${String(r.d.value)}” as ${r.def?.label.toLowerCase() || 'this item'}`)
        : h('span', { class: 'rv-ans' }, showVal(r.def, r.v),
          r.same ? h('small', { class: 'ok' }, 'Already in your profile') : r.cur ? h('small', {}, `Replaces ${showVal(r.def, r.cur)}`) : null);
      return h('div', { class: 'rv-row lib' + (r.include ? ' on' : '') }, cb,
        h('div', { class: 'rv-f' }, h('b', {}, r.label), h('small', {}, r.d.kind === 'check' ? 'Ticked' : `Found: ${String(r.d.value).slice(0, 120)}`)),
        h('div', { class: 'rv-k' }, it), result);
    };
    // Answers no item was found for are folded away; open them to assign one by hand.
    const matched = rows.filter(r => r.key), other = rows.filter(r => !r.key);
    list.replaceChildren(...matched.map(row), ...(other.length ? [h('details', { class: 'hv-more' }, h('summary', {}, `${other.length} answer${other.length > 1 ? 's' : ''} Proof couldn’t place`), ...other.map(row))] : []));
    tally();
  };
  const tally = () => { const n = rows.filter(r => r.include).length; count.textContent = `${rows.length} answers found · ${n} to add`; add.textContent = n ? `Add ${n} to the profile` : 'Add'; add.disabled = !n; };
  const m = modal('Import answers', h('p', { class: 'hint' }, `${fileName} → ${ent.name}${usedClaude ? ' · some labels matched by Claude' : ''}`), list, dl,
    h('div', { class: 'rv-foot' }, count), h('div', { class: 'actions' }, h('button', { class: 'btn quiet', onclick: () => m.close() }, 'Cancel'), add));
  m.modal.classList.add('wide');
  draw();

  function done() {
    const use = rows.filter(r => r.include && r.key && r.v != null);
    let n = 0, newPeople = 0;
    // People: group answers by role and number, then find or create each person.
    const groups = new Map();
    for (const r of use) {
      if (r.def.scope === 'person') { const g = `${r.def.role}.${r.def.n}`; if (!groups.has(g)) groups.set(g, { role: r.def.role, n: r.def.n, rows: [] }); groups.get(g).rows.push(r); }
      else if (r.def.scope === 'entity') { setValue(ent.values, r.def, r.v); n++; }
    }
    for (const g of groups.values()) {
      const nameRow = g.rows.find(r => r.def.key === 'full_name');
      const name = nameRow?.v || [g.rows.find(r => r.def.key === 'first_name')?.v, g.rows.find(r => r.def.key === 'last_name')?.v].filter(Boolean).join(' ');
      let p = name ? ent.people.find(x => norm(fullNameOf(x)) === norm(name)) : null;
      if (!p) { const atN = peopleIn(ent, g.role)[g.n - 1]; if (atN && (!name || !fullNameOf(atN))) p = atN; }
      if (!p) {
        p = { id: crypto.randomUUID(), kind: name && COMPANY_RE.test(name) ? 'company' : 'person', roles: [g.role], values: {}, order: Math.max(-1, ...ent.people.map(x => x.order ?? 0)) + 1, since: todayIso() };
        ent.people.push(p); newPeople++;
      }
      if (!p.roles.includes(g.role)) p.roles.push(g.role);
      for (const r of g.rows) { setValue(p.values, r.def, r.v); n++; }
    }
    // These labels are confirmed now; the library remembers them for filling.
    for (const r of use) learn(libLabel(r.d), r.key, r.as, r.d.kind);
    persist(); m.close();
    C.toast(`Added ${n} value${n === 1 ? '' : 's'} to the profile${newPeople ? `, including ${newPeople} new ${newPeople === 1 ? 'person' : 'people'}` : ''}.`, 6000);
    openProfile(groups.size && !use.some(r => r.def.scope === 'entity') ? 'people' : 'identity');
  }
}

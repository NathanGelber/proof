// Turning a form into proposals: which profile item goes in each field, rendered how.
// Two matchers produce the same shape:
//   local  – phrase lists from schema.js, runs on this computer;
//   claude – the Rust backend sends the form's text and the item *names* to Claude.
// Then render() turns a proposal into the actual answer, from the profile, locally.

import { PERSON_KEYS, SPECIAL_KEYS, ROLES, YESNO, entityKeys, personKeys, keyDef } from './schema.js';
import { rawValue, countryName, K, V } from './vault.js';
import { COUNTRIES } from './countries.js';
import { norm, fold } from './extract.js';

// ---------------------------------------------------------------- rendering values
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function formatDate(iso, pat) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); if (!m) return iso || '';
  const [, Y, M, D] = m;
  return pat.replace(/YYYY|YY|MMMM|MMM|MM|DD/g, t => ({ YYYY: Y, YY: Y.slice(2), MMMM: MONTHS[+M - 1], MMM: MONTHS[+M - 1].slice(0, 3), MM: M, DD: D })[t]);
}
const YES = ['yes', 'y', 'ja', 'j', 'true', 'oui', 'si', 'x', '1'];
const NO = ['no', 'n', 'nee', 'false', 'non', '0'];
const isYes = v => YES.includes(norm(v));

function pickOption(options, value, kind, map) {
  if (!options?.length) return null;
  if (map) { const want = map[norm(value)]; const o = want != null && options.find(o => norm(o) === norm(want)); if (o) return o; }
  const nv = norm(value);
  let o = options.find(o => norm(o) === nv); if (o) return o;
  if (kind === 'bool') { const syn = isYes(value) ? YES : NO.includes(nv) ? NO : null; if (syn) { o = options.find(o => syn.includes(norm(o))) || options.find(o => syn.some(s => s.length > 1 && norm(o).startsWith(s + ' '))); if (o) return o; } }
  if (kind === 'country') { const r = COUNTRIES.find(c => c[0] === value); if (r) { o = options.find(o => [r[0], r[1], r[2]].some(x => norm(o) === norm(x))) || options.find(o => norm(o).includes(norm(r[2]))); if (o) return o; } }
  const hits = options.filter(o => norm(o).includes(nv) || (norm(o).length > 2 && nv.includes(norm(o))));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * The answer for one proposal. Returns { value, show, missing, problem }:
 * value is what goes into the field (string, or boolean for a checkbox).
 */
export function render(ent, key, as, field) {
  as = as || '';
  if (as.startsWith('literal:')) { const t = as.slice(8); return { value: field?.kind === 'check' ? isYes(t) : t, show: t }; }
  const def = keyDef(ent, key); if (!def) return { missing: true, problem: 'Unknown item', show: '' };
  const raw = rawValue(ent, key);
  const kind = def.kind;
  const fk = field?.kind || 'text';
  if (raw === '' || raw == null) return { missing: true, show: '', value: fk === 'check' ? false : '' };
  if (fk === 'check' || as.startsWith('check')) {
    let on;
    const m = /^check:(!?)(.*)$/.exec(as);
    if (m && m[2] === 'any') on = true; // a yes/no tick on a flat form: the option is chosen from the value
    else if (m && m[2]) { on = norm(raw) === norm(m[2]) || (m[2] === 'yes' && isYes(raw)); if (m[1]) on = !on; }
    else on = isYes(raw);
    if (m && m[2] === 'any') return { value: true, show: `☑ tick “${isYes(raw) ? 'Yes' : 'No'}”`, raw };
    return { value: on, show: on ? '☑ ticked' : '☐ not ticked', raw };
  }
  let text;
  if (as.startsWith('date:')) text = formatDate(raw, as.slice(5));
  else if (as.startsWith('country:')) { const r = COUNTRIES.find(c => c[0] === raw); text = !r ? raw : as === 'country:iso2' ? r[0] : as === 'country:iso3' ? r[1] : r[2]; }
  else if (kind === 'date') text = formatDate(raw, K.P?.settings?.dateFormat || 'DD-MM-YYYY');
  else if (kind === 'country') text = countryName(raw);
  else if (kind === 'bool') text = isYes(raw) ? 'Yes' : 'No';
  else text = String(raw);
  if (as === 'upper') text = text.toUpperCase();
  if (fk === 'select' || fk === 'radio') {
    let map = null;
    if (as.startsWith('select:')) { map = {}; for (const p of as.slice(7).split('|')) { const [a, b] = p.split('='); if (b != null) map[norm(a)] = b; } }
    const o = pickOption(field.options, kind === 'country' ? raw : kind === 'bool' ? raw : text, kind, map) || pickOption(field.options, text, 'text', null);
    if (!o) return { value: '', show: text, problem: `None of the options matches “${text}”` };
    return { value: o, show: o };
  }
  if (field?.maxLen && text.length > field.maxLen) return { value: text.slice(0, field.maxLen), show: text, problem: `Cut to ${field.maxLen} characters` };
  return { value: text, show: text };
}

// ---------------------------------------------------------------- local matcher
const SKIP_RE = /\b(signature|handtekening|sign here|initials|paraaf|unterschrift|stamp|stempel)\b/;
// Internal names that say nothing: "Text7", "Check Box12", "Dropdown3".
const GENERIC_NAME = /^(text|tekst|check ?box|check|selectievakje|dropdown|drop down|list ?box|combo ?box|field|veld|radio ?button|option|button)\s*\d*$/i;
// "Any director or beneficial owner…" is about the entity, not one person.
const ABOUT_ALL = /\b(any|all|none|each|every|whether|either)\b/;
const OFFICE_RE = /\b(for (office|bank|internal|official) use|(office|bank|internal) use only|reserved for|in te vullen door de bank|voor intern gebruik|to be completed by (the )?bank)\b/;
const ROLE_ALIASES = ROLES.flatMap(r => r.aliases.map(a => [norm(a), r.role])).sort((a, b) => b[0].length - a[0].length);

function hasPhrase(t, a) { if (!t || !a) return false; return (' ' + t + ' ').includes(' ' + a + ' '); }

/** Role and person number implied by some text, e.g. "Director 2" → {role:'director', n:2}. */
export function roleIn(...texts) {
  for (const raw of texts) {
    const t = norm(raw); if (!t) continue;
    for (const [a, role] of ROLE_ALIASES) {
      if (!hasPhrase(t, a)) continue;
      const after = t.slice(t.indexOf(a) + a.length);
      const m = /^\s*(?:no |nr |number |#)?(\d{1,2})\b/.exec(after);
      return { role, n: m ? +m[1] : 0 };
    }
  }
  return null;
}
function trailingNumber(...texts) { for (const t of texts) { const m = /(?:^|\D)(\d{1,2})\s*$/.exec(norm(t)); if (m && +m[1] < 20) return +m[1]; } return 0; }

// Words that don't change what a label asks for.
const FILLER = new Set(['of', 'the', 'entity', 'entitys', 'company', 'companys', 'if', 'applicable', 'different', 'please', 'provide', 'state', 'specify', 'enter', 'your', 'its', 'an', 'a', 'in', 'for', 'to', 'be', 'is', 'are', 'this', 'client', 'customer', 'applicant', 'organisation', 'organization', 'institution', 'details', 'tick', 'one', 'only', 'dd', 'mm', 'yyyy', 'yy', 'jjjj', 'de', 'het', 'van', 'naam', 'and', 'or', 'any', 'if any', 'no', 'nr', 'number', 'optional', 'required', 'mandatory', 'e', 'g', 'eg', 'i', 'yes', 'ja', 'nee', 'oui', 'non', 'by', 'door']);
const ROLE_WORDS = new Set(ROLES.flatMap(r => r.aliases.flatMap(a => norm(a).split(' '))));
const DIGIT = /^\d+$/;

/** Best item for a piece of label text, with score and how exact it was. */
function bestKey(texts, candidates) {
  let best = null;
  for (const [t, w] of texts) {
    if (!t) continue;
    const tw = t.split(' ');
    for (const c of candidates) for (const a of c.na) {
      if (!hasPhrase(t, a)) continue;
      const own = new Set(c.na.flatMap(x => x.split(' ')));
      const aw = a.split(' ').length;
      const extra = tw.filter(x => !own.has(x) && !FILLER.has(x) && !DIGIT.test(x) && !(c.scope === 'person' && ROLE_WORDS.has(x))).length;
      const exact = extra <= 0;
      const score = w * (aw * 10 + (exact ? 30 : 0) - Math.min(extra, 12) + c.bonus);
      if (!best || score > best.score) best = { c, score, exact, extra };
    }
  }
  return best;
}

const prep = (list, scope, bonus = 0) => list.map(d => ({ ...d, scope, bonus, na: [...new Set(d.aliases.map(norm).filter(Boolean))] }));
function dateAs(text) {
  const m = /\b(dd|mm|yyyy|jjjj)([\/.\- ])(dd|mm)\2(yyyy|yy|jjjj|dd)\b/i.exec(text || '') || /\b(yyyy)([\/.\- ])(mm)\2(dd)\b/i.exec(text || '');
  if (!m) return 'date:' + (K.P?.settings?.dateFormat || 'DD-MM-YYYY');
  return 'date:' + m[0].toUpperCase().replace(/JJJJ/g, 'YYYY');
}
function countryAs(f, text) { if (f.maxLen === 2 || /\b(iso|code)\b/i.test(text)) return 'country:iso2'; if (f.maxLen === 3) return 'country:iso3'; return 'country:name'; }

// ---------------------------------------------------------------- label library
// Labels you've confirmed, mapped to profile items. Person items are kept without role or
// number ("person:date_of_birth"); which person a field means still comes from its context.
export const libKey = label => norm(label).replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
export function libLookup(...labels) {
  const L = K.P?.library; if (!L) return null;
  for (const l of labels) { const k = libKey(l); if (k && L[k]) return { ...L[k], label: k }; }
  return null;
}
/** Remember a confirmed label → item. The latest confirmation wins. */
export function learn(label, key, as, kind) {
  if (!K.P || !key || (as || '').startsWith('literal:')) return;
  const k = libKey(label); if (!k || k.length > 160 || k.split(' ').length > 25) return;
  const m = /^[a-z_]+\.\d+\.([a-z0-9_]+)$/.exec(key);
  const item = m ? 'person:' + m[1] : key;
  const L = (K.P.library ||= {}); const old = L[k];
  const keepAs = kind === 'check' ? as : undefined;
  L[k] = { key: item, ...(keepAs ? { as: keepAs } : {}), n: old && old.key === item ? (old.n || 0) + 1 : 1, at: new Date().toISOString().slice(0, 10) };
}
/** The label a field is remembered by. Tick boxes include their question, or every "Yes" box would look alike. */
export function libLabel(f) {
  if (f.kind === 'check') {
    // "Passive NFFE" says it all; "Yes" only means something with its question.
    if (f.right && !/^(yes|no|ja|nee|y|n|j|true|false|oui|non|si|nein)\b/i.test(f.right.trim())) return f.right;
    return [f.left || f.tip || f.above || '', f.right || ''].filter(Boolean).join(' → ');
  }
  return f.tip || f.left || f.above || f.inside || (GENERIC_NAME.test(f.nice || '') ? '' : f.nice) || '';
}
function libPick(entry, E, Pk) {
  if (!entry) return null;
  if (entry.key.startsWith('person:')) { const c = Pk.find(d => d.key === entry.key.slice(7)); return c ? { c, exact: true, lib: entry } : null; }
  const c = E.find(d => d.key === entry.key); return c ? { c, exact: true, lib: entry } : null;
}

/** Lines above a field that can head a block about a person ("Beneficial owner 2", "Director 1"), not other labels ("Signed by:"). */
const blockLines = ctx => (ctx || []).filter(t => !/[:?_]\s*$|_{3,}/.test(t) && norm(t).split(' ').length <= 6);

/** A remembered label only applies where it fits: person items inside a block about a person, company items outside one. */
function fitsScope(pick, ctx) {
  if (!pick || pick.c.key === 'today') return pick;
  return (pick.c.scope === 'person') === !!ctx ? pick : null;
}

/** Local proposals for fillable fields. */
export function localFields(ent, fields) {
  const E = prep([...entityKeys(ent), ...SPECIAL_KEYS], 'entity');
  const Pk = prep(personKeys(ent), 'person', 2);
  const choiceKeys = [...entityKeys(ent), ...personKeys(ent)].filter(d => d.kind === 'choice');
  const roleCount = {}; // auto-numbering of repeated unnumbered person blocks
  const out = [];
  for (const f of fields) {
    if (f.ro) continue;
    const label = norm(f.tip) || norm(f.left) || norm(f.above) || norm(f.inside) || norm(f.nice);
    const all = [f.tip, f.left, f.above, f.inside, f.nice, f.right].map(norm).join(' ');
    if (OFFICE_RE.test(norm(f.section) + ' ' + all)) continue;
    if (f.kind === 'text' && SKIP_RE.test(label + ' ' + norm(f.nice))) continue;
    const nice = GENERIC_NAME.test(f.nice || '') ? '' : f.nice;
    const own = [f.kind === 'check' ? f.right : '', f.left, f.tip, f.above, nice].filter(Boolean);
    const ctx = own.some(t => ABOUT_ALL.test(norm(t))) ? null : roleIn(...own) || roleIn(...blockLines(f.ctx)) || roleIn(f.section);
    const texts = [[norm(f.tip), 1], [norm(f.left), 0.95], [norm(f.above), 0.9], [norm(f.inside), 0.85], [norm(nice), 0.7]];
    if (f.kind === 'check') texts.unshift([norm(f.right), 1]);
    let pick = fitsScope(libPick(f.kind === 'check' ? libLookup(libLabel(f)) : libLookup(f.tip, f.left, f.above, f.inside, nice), E, Pk), ctx), as = pick?.lib.as || '', conf = 'low', note = '';
    // Checkboxes whose label is one of a choice list (FATCA classes, ID types…).
    if (f.kind === 'check' && !pick) {
      const lab = norm(f.right) || norm(f.left) || norm(f.tip) || norm(f.nice);
      for (const d of choiceKeys) for (const ch of d.choices) if (lab && (lab === norm(ch) || (norm(ch).length > 6 && lab.includes(norm(ch))))) { pick = { c: { ...d, scope: PERSON_KEYS.includes(d) ? 'person' : 'entity' }, exact: true }; as = 'check:' + ch; }
    }
    if (!pick) {
      const cands = ctx ? [...Pk, ...E.map(e => ({ ...e, bonus: -4 }))] : E;
      let b = bestKey(texts, cands);
      if (f.kind === 'check' || f.kind === 'radio' || f.kind === 'select') {
        // A yes/no box answers the question printed beside or above it.
        const ok = d => ['bool', 'choice', 'country'].includes(d.kind) || (f.kind !== 'check' && d.kind !== 'longtext');
        if (b && !ok(b.c)) b = bestKey(texts, cands.filter(ok));
      }
      // A label that only names a role ("Signed by", "UBO 2:", "Director") wants that person's name.
      if ((!b || b.score < 14) && ctx && f.kind === 'text') {
        const words = norm(f.tip || f.left || f.above || '').split(' ').filter(Boolean);
        if (words.length && words.every(w => ROLE_WORDS.has(w) || FILLER.has(w) || DIGIT.test(w) || ['by', 'name', 'naam', 'signed', 'ondertekend', 'door'].includes(w))) b = { c: Pk.find(d => d.key === 'full_name'), score: 20, exact: false, extra: 1 };
      }
      if (!b || b.score < 14) continue;
      pick = b;
    }
    const d = pick.c;
    let key = d.key;
    if (d.scope === 'person') {
      const role = ctx?.role || 'director';
      let n = ctx?.n || trailingNumber(nice, f.left, f.tip) || 0;
      if (!n) { const blk = role + '|' + f.section; roleCount[role] ||= { blocks: [] }; if (!roleCount[role].blocks.includes(blk)) roleCount[role].blocks.push(blk); n = roleCount[role].blocks.indexOf(blk) + 1; }
      key = `${role}.${n}.${d.key}`;
      if (!ctx) note = 'Assumed this is about a director. Check which person it means.';
    }
    if (!as) {
      if (f.kind === 'check') {
        const side = norm(f.right || f.inside || f.nice);
        if (d.kind === 'bool') as = /\b(no|nee|non|nein)\b/.test(side) ? 'check:!yes' : 'check';
        else as = 'check';
      } else if (f.kind === 'select' || f.kind === 'radio') as = 'select';
      else if (d.kind === 'date') as = dateAs([f.tip, f.left, f.above, f.inside].join(' '));
      else if (d.kind === 'country') as = countryAs(f, [f.tip, f.left, f.above].join(' '));
      else as = 'text';
    }
    conf = pick.exact ? (d.scope === 'person' && !ctx ? 'medium' : 'high') : pick.extra <= 3 ? 'medium' : 'low';
    out.push({ id: f.id, key, as, confidence: pick.lib ? 'high' : conf, note, source: pick.lib ? 'library' : 'local' });
  }
  return out;
}

/** Local proposals for a flat form: label lines and where the answer goes. */
export function localLines(ent, lines) {
  const E = prep([...entityKeys(ent), ...SPECIAL_KEYS], 'entity');
  const Pk = prep(personKeys(ent), 'person', 2);
  let ctx = null, section = '';
  const blocks = {}; const out = [];
  for (const l of lines) {
    if (l.heading) { section = l.text; ctx = roleIn(l.text); if (OFFICE_RE.test(norm(l.text))) ctx = { office: true }; continue; }
    if (ctx?.office) continue;
    const words = norm(l.text).split(' ').length;
    if (words > 14) continue;
    // A label is the text before a colon or a blank; take the first one on the line.
    const m = /^(.*?)(?::|_{3,}|\.{4,}|\s{2,}|$)/.exec(l.text);
    const label = norm(m ? m[1] : l.text);
    if (!label || SKIP_RE.test(label)) continue;
    const cands = ctx ? [...Pk, ...E.map(e => ({ ...e, bonus: -4 }))] : E;
    const b = fitsScope(libPick(libLookup(m ? m[1] : l.text), E, Pk), ctx?.office ? null : ctx) || bestKey([[label, 1]], cands);
    if (!b || (!b.lib && b.score < 14)) continue;
    let key = b.c.key;
    if (b.c.scope === 'person') {
      const role = ctx?.role || 'director';
      let n = ctx?.n || 0;
      if (!n) { (blocks[role] ||= []); if (!blocks[role].includes(section)) blocks[role].push(section); n = blocks[role].indexOf(section) + 1; }
      key = `${role}.${n}.${b.c.key}`;
    }
    if (b.c.kind === 'bool' && /\b(yes|ja|oui)\b/i.test(l.text) && /\b(no|nee|non)\b/i.test(l.text)) {
      out.push({ id: l.id, key, as: 'check:any', place: 'mark', option: '@yesno', confidence: b.exact ? 'medium' : 'low', note: '', source: 'local' });
      continue;
    }
    const as = b.c.kind === 'date' ? dateAs(l.text) : b.c.kind === 'country' ? 'country:name' : 'text';
    const place = /:\s*$/.test(l.text.trim()) && !/_{3,}/.test(l.text) && l.text.length < 40 ? 'right' : /_{3,}|\.{4,}|:/.test(l.text) ? 'right' : 'below';
    out.push({ id: l.id, key, as, place, label: m ? m[1] : l.text, confidence: b.exact ? 'high' : 'low', note: '', source: b.lib ? 'library' : 'local' });
  }
  return out;
}

// ---------------------------------------------------------------- Claude matcher (through the Rust backend)
export function keyCatalog(ent) {
  const ch = d => d.kind === 'bool' ? YESNO : d.choices || (d.kind === 'country' ? ['ISO country code'] : []);
  const kind = d => (d.kind === 'computed' ? 'text' : d.kind);
  return [
    ...entityKeys(ent).map(d => ({ key: d.key, label: d.label, kind: kind(d), choices: ch(d) })),
    ...SPECIAL_KEYS.map(d => ({ key: d.key, label: d.label, kind: kind(d), choices: [] })),
    ...ROLES.map(r => ({ key: r.role, label: r.plural, kind: 'role', choices: [] })),
    ...personKeys(ent).map(d => ({ key: `{role}.N.${d.key}`, label: d.label, kind: kind(d), choices: ch(d) })),
  ];
}

/** Validate what came back: known ids, keys that exist, sane transforms. */
function clean(list, ids, ent) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || !ids.has(m.id)) continue;
    if (m.key == null) { out.push({ id: m.id, key: null, confidence: m.confidence || 'low', note: m.note || '', source: 'claude' }); continue; }
    const key = String(m.key);
    if (!keyDef(ent, key)) continue;
    const as = typeof m.as === 'string' ? m.as.slice(0, 200) : '';
    if (as.startsWith('literal:') && as.length > 40) continue; // fixed text is for "N/A"-style answers only
    out.push({ id: m.id, key, as, confidence: ['high', 'medium', 'low'].includes(m.confidence) ? m.confidence : 'low', note: typeof m.note === 'string' ? m.note.slice(0, 300) : '', place: m.place, option: m.option, label: m.label, source: 'claude' });
  }
  return out;
}

/** Lines of a flat form that ask something: short, and ending in a colon, blank, tick box or question mark. */
export const isQuestionLine = l => l.heading || (l.text.length <= 140 && (/[:?]\s*$/.test(l.text) || /_{3,}|\.{4,}|…{2,}|\[\s*\]|[☐□]/.test(l.text) || /:\s+\S/.test(l.text) && l.text.length <= 80));

/**
 * What Claude gets. Only the text that labels each answer spot: no file name, no letterhead,
 * no instructions, no surrounding lines. The backend then masks emails, URLs, phone and account
 * numbers, dates and long numbers, and cuts the counterparty's name and the profile's values.
 */
export function claudeRequest(ent, { fields, lines, avoid }) {
  const model = K.P?.settings?.model || 'claude-sonnet-5-5';
  const base = { model, title: '', keys: keyCatalog(ent), avoid: (avoid || []).filter(Boolean) };
  if (fields) return { ...base, mode: 'fields', fields: fields.filter(f => !f.ro).map(f => {
    const role = roleIn(...blockLines(f.ctx).slice(0, 4)) || roleIn(f.section);
    const near = [f.left && `left: ${f.left}`, f.above && `above: ${f.above}`, f.right && `right: ${f.right}`, f.inside && `inside: ${f.inside}`, f.below && `below: ${f.below}`, role && `in a block about ${role.role}${role.n ? ' ' + role.n : ''}`].filter(Boolean).join(' · ');
    return { id: f.id, kind: f.kind, page: f.page, name: GENERIC_NAME.test(f.nice || '') ? '' : f.nice || '', tip: f.tip, near, section: f.section, options: f.options };
  }) };
  return { ...base, mode: 'lines', lines: lines.filter(isQuestionLine).map(l => ({ id: l.id, page: l.page, text: (l.heading ? '## ' : '') + l.text })) };
}

/** Run Claude over the form in chunks. Returns {matches, removed}. */
export async function claudeMatch(ent, { fields, lines, avoid }, onProgress) {
  const items = fields ? fields.filter(f => !f.ro) : lines.filter(isQuestionLine);
  const size = fields ? 140 : 260;
  const chunks = []; for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  const ids = new Set(items.map(x => x.id));
  let removed = 0, done = 0; const all = [];
  const run = async c => {
    const req = claudeRequest(ent, fields ? { fields: c, avoid } : { lines: c, avoid });
    const r = await V.match(req);
    removed += r.removed || 0; all.push(...clean(r.matches, ids, ent)); onProgress?.(++done, chunks.length);
  };
  for (let i = 0; i < chunks.length; i += 3) await Promise.all(chunks.slice(i, i + 3).map(run));
  return { matches: all, removed };
}

/** The label text before a colon or blank on a line of a flat form. */
export const lineLabel = t => (/^(.*?)(?::|_{3,}|\.{4,}|\s{2,}|$)/.exec(t) || [, t])[1].trim();
/** What to call a field in lists: its printed label, or for a tick box, the option beside it. */
export const fieldLabel = f => (f.kind === 'check' ? (f.where && f.left && f.right ? `${f.left} → ${f.right}` : f.right || f.tip || f.left || f.inside || f.above) : f.tip || f.left || f.above || f.inside || f.right) || f.text || f.nice || f.name || '';

/** How to write a value into a field, worked out from the item and the field's own label. */
export function autoAs(ent, key, f) {
  const d = keyDef(ent, key); const fk = f?.kind || 'text';
  const text = [f?.tip, f?.left, f?.above, f?.inside, f?.text].filter(Boolean).join(' ');
  if (fk === 'check') {
    if (d?.kind === 'choice') { const lab = norm(f.right || f.left || f.tip || ''); const ch = d.choices.find(c => lab && (lab === norm(c) || lab.includes(norm(c)))); return ch ? 'check:' + ch : 'check'; }
    return /\b(no|nee|non|nein)\b/.test(norm(f.right || '')) ? 'check:!yes' : 'check';
  }
  if (fk === 'select' || fk === 'radio') return 'select';
  if (d?.kind === 'date') return dateAs(text);
  if (d?.kind === 'country') return countryAs(f || {}, text);
  return 'text';
}

/** For a yes/no tick on a flat form: the option text on the line that matches the value. */
export function yesNoOption(line, raw) {
  const words = (isYes(raw) ? ['yes', 'ja', 'oui', 'y'] : ['no', 'nee', 'non', 'n']);
  for (const s of line.segs) for (const w of s.str.split(/[^A-Za-zÀ-ÿ]+/)) if (words.includes(fold(w))) return w;
  return null;
}

/** Where to type an answer on a flat form, in PDF user space. */
export function placeOnLine(line, m, size) {
  const segs = line.segs; const txt = segs.map(s => s.str).join(' ');
  const charW = s => (s.x1 - s.x0) / Math.max(1, s.str.length);
  const sz = Math.max(7, Math.min(11, size || line.size || 10));
  if (m.place === 'below') return { x: line.x0, y: line.y - line.size * 1.45, size: sz };
  if (m.place === 'mark' && m.option) {
    const want = fold(m.option);
    for (const s of segs) {
      const i = fold(s.str).indexOf(want); if (i < 0) continue;
      const x = s.x0 + i * charW(s);
      const box = s.str.slice(0, i).search(/[☐□■▢◻\[\(](\s*[\]\)])?\s*$/);
      return { x: box >= 0 ? s.x0 + (box + 0.45) * charW(s) : x - sz * 1.1, y: line.y, size: sz, mark: true };
    }
    return { x: line.x0 - sz * 1.2, y: line.y, size: sz, mark: true };
  }
  // right: after the label (or at the start of the blank that follows it)
  let after = null;
  if (m.label) { const want = fold(m.label).trim(); for (const s of segs) { const i = fold(s.str).indexOf(want); if (i >= 0) { after = { s, i: i + want.length }; break; } } }
  if (!after) after = { s: segs[0], i: (() => { const c = segs[0].str.indexOf(':'); return c >= 0 ? c + 1 : segs[0].str.length; })() };
  const { s, i } = after;
  const rest = s.str.slice(i);
  const blank = rest.search(/[_.]{3,}/);
  if (blank >= 0) return { x: s.x0 + (i + blank) * charW(s) + 2, y: line.y + 1, size: sz };
  const colon = rest.match(/^\s*:?/)[0].length;
  if (i + colon >= s.str.length) {
    const nxt = segs[segs.indexOf(s) + 1];
    if (nxt && /^[_.]{3,}/.test(nxt.str)) return { x: nxt.x0 + 2, y: line.y + 1, size: sz };
    return { x: s.x1 + sz * 0.6, y: line.y, size: sz };
  }
  return { x: s.x0 + (i + colon) * charW(s) + sz * 0.4, y: line.y, size: sz };
}


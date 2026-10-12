// The profile as the page sees it, and the bridge to the encrypted vault in the Rust backend.
// In a plain browser (development and tests) the vault is simulated in memory.

import { isDesktop } from '../host.js';
import { ENUM_KINDS, keyDef, entityKeys, personKeys, newProfile } from './schema.js';
import { COUNTRIES } from './countries.js';

let core = null;
if (isDesktop) core = await import('@tauri-apps/api/core');

// ---------------------------------------------------------------- browser stand-in
const mock = { exists: false, pass: null, data: null, docs: new Map(), unlocked: false, key: false };
const mockCall = async (cmd, a = {}) => {
  const locked = () => { if (!mock.unlocked) throw 'LOCKED: The profile is locked.'; };
  switch (cmd) {
    case 'vault_info': return { path: '(browser memory)', exists: mock.exists, unlocked: mock.unlocked, has_key: mock.key || !!window.__mockMatch };
    case 'vault_create': mock.exists = true; mock.pass = a.passphrase; mock.data = a.initial; mock.unlocked = true; return;
    case 'vault_unlock': if (a.passphrase !== mock.pass) throw 'WRONGPASS: That passphrase didn’t work.'; mock.unlocked = true; return mock.data;
    case 'vault_lock': mock.unlocked = false; return;
    case 'vault_get': locked(); return mock.data;
    case 'vault_save': locked(); mock.data = a.data; return;
    case 'vault_passphrase': locked(); if (a.old !== mock.pass) throw 'WRONGPASS: The current passphrase is wrong.'; mock.pass = a.new; return;
    case 'vault_doc_get': locked(); return mock.docs.get(a.id).buffer;
    case 'vault_doc_delete': locked(); mock.docs.delete(a.id); return;
    case 'vault_backup': return '0';
    case 'vault_use': return;
    case 'api_key_set': mock.key = !!a.key; return;
    case 'match_fields': locked(); if (!window.__mockMatch) throw 'NOKEY: No Anthropic API key is set. Add one under Profile → Settings.'; return window.__mockMatch(a.request);
    case 'match_preview': locked(); return ['(browser preview) ' + JSON.stringify(a.request).slice(0, 4000), 0];
  }
  throw 'Unknown command ' + cmd;
};
const call = (cmd, args, opts) => (isDesktop ? core.invoke(cmd, args, opts) : mockCall(cmd, args));
const errText = e => String(e?.message || e);

// ---------------------------------------------------------------- vault calls
export const V = {
  info: () => call('vault_info'),
  async create(passphrase, profile, path) { await call('vault_create', { passphrase, initial: JSON.stringify(profile), path: path || null }); },
  async unlock(passphrase) { return JSON.parse(await call('vault_unlock', { passphrase })); },
  lock: () => call('vault_lock'),
  async save(profile, force = false) { await call('vault_save', { data: JSON.stringify(profile), force }); },
  passphrase: (old, nw) => call('vault_passphrase', { old, new: nw }),
  async docPut(id, bytes) {
    if (!isDesktop) { mock.docs.set(id, bytes.slice()); return; }
    await core.invoke('vault_doc_put', bytes, { headers: { 'x-id': id } });
  },
  async docGet(id) { return new Uint8Array(await call('vault_doc_get', { id })); },
  docDelete: id => call('vault_doc_delete', { id }),
  backup: dest => call('vault_backup', { dest }),
  use: path => call('vault_use', { path }),
  setKey: key => call('api_key_set', { key }),
  match: request => call('match_fields', { request }),
  preview: request => call('match_preview', { request }),
};
export const errKind = e => (/^([A-Z]+):/.exec(errText(e)) || [])[1] || '';
export const errMsg = e => errText(e).replace(/^[A-Z]+:\s*/, '');

// ---------------------------------------------------------------- in-memory profile
export const K = { P: null, info: null, listeners: new Set(), saveT: null, saving: null };
export const onChange = fn => K.listeners.add(fn);
const emit = () => K.listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } });

export async function refreshInfo() { K.info = await V.info(); if (!K.info.unlocked && K.P) { K.P = null; emit(); } return K.info; }
export async function unlockWith(pass) { K.P = upgrade(await V.unlock(pass)); K.info = await V.info(); emit(); return K.P; }
export async function createWith(pass, entityName, path) {
  const { newEntity } = await import('./schema.js');
  const P = newProfile(); if (entityName) P.entities.push(newEntity(entityName));
  await V.create(pass, P, path); K.P = P; K.info = await V.info(); emit(); return P;
}
export async function lockNow() { clearTimeout(K.saveT); if (K.P && K.dirty) await flush().catch(() => {}); await V.lock(); K.P = null; K.info = await V.info(); emit(); }
function upgrade(P) { const d = newProfile(); P.settings = { ...d.settings, ...(P.settings || {}) }; P.mappings ||= {}; P.log ||= []; P.entities ||= []; return P; }

/** Persist soon. Edits are batched for half a second. */
export function persist() { K.dirty = true; clearTimeout(K.saveT); K.saveT = setTimeout(() => flush().catch(onSaveError), 500); emit(); }
export async function flush(force = false) {
  clearTimeout(K.saveT); if (!K.P || !K.dirty) return;
  K.dirty = false;
  try { await V.save(K.P, force); }
  catch (e) { K.dirty = true; throw e; }
}
let saveErrorHandler = e => console.error(e);
export const setSaveErrorHandler = fn => (saveErrorHandler = fn);
function onSaveError(e) { saveErrorHandler(e); }

// ---------------------------------------------------------------- values
export const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const entityById = id => K.P?.entities.find(e => e.id === id) || null;
const active = p => !p.until || p.until > todayIso();
export const peopleIn = (ent, role) => ent.people.filter(p => p.roles.includes(role) && active(p)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

export const countryName = c => COUNTRIES.find(r => r[0] === c)?.[2] || c || '';
export function computed(def, bag, ent) {
  const parts = def.from.map(f => {
    const v = bag[f]?.v || ''; const d = (def.key === 'full_name' ? personKeys(ent) : [...entityKeys(ent), ...personKeys(ent)]).find(x => x.key === f);
    return d?.kind === 'country' ? countryName(v) : v;
  });
  if (def.key === 'full_name') return parts.filter(Boolean).join(' ');
  const [street, pc, city, country] = parts;
  return [street, [pc, city].filter(Boolean).join(' '), country].filter(Boolean).join(', ');
}

/** The stored value for a key (raw: ISO dates, ISO country codes, yes/no). '' when there is none. */
export function rawValue(ent, key) {
  const d = keyDef(ent, key); if (!d) return '';
  if (d.scope === 'special') return key === 'today' ? todayIso() : '';
  let bag;
  if (d.scope === 'person') { const p = peopleIn(ent, d.role)[d.n - 1]; if (!p) return ''; bag = p.values; }
  else bag = ent.values;
  const own = bag[d.key]?.v;
  if (d.kind === 'computed') return own || computed(d, bag, ent);
  return own ?? '';
}

/** Set a value, keeping the previous one in its history. */
export function setValue(bag, def, v) {
  const now = todayIso(); const cur = bag[def.key];
  v = typeof v === 'string' ? v.replace(/\r\n/g, '\n') : v;
  if ((cur?.v ?? '') === v) return false;
  const hist = cur?.hist || [];
  if (cur && cur.v !== '' && cur.v != null) hist.unshift({ v: cur.v, at: cur.at, until: now, ...(cur.e ? { e: true } : {}) });
  bag[def.key] = { v, at: now, hist: hist.slice(0, 50), ...(ENUM_KINDS.has(def.kind) ? { e: true } : {}) };
  persist(); return true;
}

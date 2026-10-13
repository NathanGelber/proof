// Dates are typed as day-month-year in a plain text box: one Tab stop, the same order everywhere,
// whatever the computer's locale. Stored as ISO (YYYY-MM-DD).
import { parseDate } from './harvest.js';

export const showDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : iso || ''; };
/** ISO date from what was typed, '' for nothing, null when it isn't a date. */
export const readDate = t => { t = String(t || '').trim(); return t ? parseDate(t) : ''; };

export function dateInput(h, iso, onIso, attrs = {}) {
  const el = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'DD-MM-YYYY', spellcheck: 'false', autocomplete: 'off', ...attrs });
  el.value = showDate(iso);
  el.addEventListener('change', () => {
    const v = readDate(el.value);
    if (v == null) { el.classList.add('bad'); el.title = 'Not a date'; return; }
    el.classList.remove('bad'); el.removeAttribute('title'); el.value = showDate(v); onIso(v);
  });
  return el;
}

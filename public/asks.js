// The user decision queue: /asks lists only the open user decisions (conflicts and taste picks), newest first, each in
// the fixed shape from /user-ask.js. A tap picks one choice; Send posts exactly the snapshot on screen
// (POST /api/asks/<card>/answer {ask, revision, scope, choice, comment?}). Every value goes in through textContent /
// setAttribute, never as HTML. ?sample=1 shows one made-up decision, marked as an example, and never sends anything.
import { askLines, FIXED_CHOICE } from '/user-ask.js';

// Same language rule as the board: ?lang=, else the saved choice, else English.
const LANG = (() => {
  let l = new URLSearchParams(location.search).get('lang');
  if (l !== 'ko' && l !== 'en') { try { l = localStorage.getItem('dasks.lang'); } catch { l = null; } }
  return l === 'ko' ? 'ko' : 'en';
})();
/** UI copy for `key` in the current language ({name} filled from vars). */
function tr(key, vars) {
  const d = (typeof DICT === 'object' && (DICT[LANG] || DICT.en)) || {};
  let s = d[key] ?? DICT?.en?.[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  return s;
}
document.documentElement.lang = LANG;
document.title = `Dasks · ${tr('nav.asks')}`;
const heading = document.getElementById('asks-title');
if (heading) heading.textContent = tr('nav.asks');

const REFRESH_MS = 60_000;
const main = document.getElementById('asks');
const SAMPLE = new URLSearchParams(location.search).get('sample') === '1';
const S = { doc: null, error: false, pick: new Map(), memo: new Map(), sending: new Set(), err: new Map(), done: new Map(), bgOpen: new Set() };
/** UI state belongs to one exact question (card, ask, revision, scope): a new ask, a changed card or a new spec version
 *  starts clean, so an old pick is never sent for a new question. */
const keyOf = (it) => `${it.card}|${it.request.ask}|${it.request.revision}|${it.request.scope}`;

/** Background: the card's history, folded; open stays open for the same question (keyOf) across answers and live refreshes. */
function bgFold(it, lines) {
  const k = keyOf(it);
  const auto = SPLIT.matches && !S.bgOpen.has(k); // opened for the wide layout, not by the user: its toggle event is not remembered
  const d = h('details', { class: 'ask-bg', open: S.bgOpen.has(k) || SPLIT.matches, 'data-key': k, 'data-auto': auto ? '1' : null }, h('summary', { class: 'more-link', text: tr('asks.bg') }), h('dl', { class: 'ask-lines' }, lines));
  // Only the user's own taps are remembered; the wide-screen auto-open (syncBg) is not.
  d.addEventListener('toggle', () => { if (d.dataset.auto) { delete d.dataset.auto; return; } if (d.open) S.bgOpen.add(k); else S.bgOpen.delete(k); });
  return d;
}
/** Wide screens show the background beside the card, open; narrow ones fold it. Crossing the width only opens or closes the folds
 *  in place (no redraw), so a memo being typed, the focused button and the pick all stay. */
const SPLIT = window.matchMedia('(min-width: 1100px)');
function syncBg() {
  for (const d of document.querySelectorAll('details.ask-bg')) {
    const want = SPLIT.matches || S.bgOpen.has(d.dataset.key);
    if (d.open !== want) { d.dataset.auto = '1'; d.open = want; }
  }
}
SPLIT.addEventListener?.('change', syncBg);
/** Lines that stay in front of the options; the rest of a card's context folds under Background. The labels are the
 *  fixed ones user-ask.js writes (they are part of the signed text, so they stay as they are). */
const FRONT = new Set(['Pick', 'Recommended', 'Choices']);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

function ago(iso) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(m)) return '';
  const span = m < 60 ? tr('unit.m', { n: m }) : m < 48 * 60 ? tr('unit.h', { n: Math.round(m / 60) }) : tr('unit.d', { n: Math.round(m / 1440) });
  return tr('ago', { t: span });
}



function item(it) {
  // The recommendation starts picked (its mark filled, like a radio group's default), so the selection and the send
  // label ("Send the recommended A") always agree; a tap picks another option.
  const chosen = S.pick.get(keyOf(it)) ?? '';
  const pick = chosen || it.rec?.key || '';
  const sending = S.sending.has(keyOf(it));
  const choices = [...it.options.filter((o) => o.key !== FIXED_CHOICE.key), FIXED_CHOICE];
  // Each option says what it does on its own button, so the choices line (the same text again) is left out.
  const lines = it.lines.filter((l) => l.label !== 'Choices' || !it.options.length).map((l) => h('div', { class: `ask-line${l.label === 'Recommended' ? ' rec' : ''}`, 'data-label': l.label }, h('dt', { text: l.label }), h('dd', { text: l.value })));
  const buttons = choices.map((o) => {
    const fixed = o.key === FIXED_CHOICE.key;
    const on = pick === o.key;
    // One layout per option: the mark, the text (its own column, so long options wrap inside it), then one right slot
    // with the recommended badge over what the choice does.
    const rec = !fixed && o.key === it.rec?.key ? h('span', { class: 'ds-badge ask-recbadge', 'data-tone': 'info', text: tr('asks.rec') }) : null;
    const effect = ['proceed', 'respec', 'cancel'].includes(o.effect) ? tr(`asks.effect.${o.effect}`) : '';
    const eff = !fixed && effect ? h('span', { class: 'ask-eff' }, h('span', { class: 'ico ico-arrow', 'aria-hidden': 'true' }), h('span', { text: effect })) : null;
    const b = h('button', { type: 'button', class: `ds-button ask-choice${fixed ? ' quiet' : ''}`, 'data-variant': fixed ? 'ghost' : 'secondary', // picked = filled mark + accent edge (asks.css); the send button is the one primary
      'aria-pressed': on ? 'true' : 'false', disabled: sending, 'data-choice': o.key },
      h('span', { class: 'ask-opt', text: fixed ? tr('asks.none') : `${o.key} · ${o.text}` }), rec || eff ? h('span', { class: 'ask-side' }, rec, eff) : null);
    b.addEventListener('click', () => { S.pick.set(keyOf(it), o.key); S.err.delete(keyOf(it)); render(); });
    return b;
  });
  const memo = h('input', { class: 'ds-input ask-memo', type: 'text', maxlength: 200, placeholder: tr('asks.memo.ph'), 'aria-label': tr('asks.memo'), disabled: sending });
  memo.value = S.memo.get(keyOf(it)) ?? '';
  memo.addEventListener('input', () => { S.memo.set(keyOf(it), memo.value); });
  // The send button is filled only once there is something to send.
  const send = h('button', { type: 'button', class: 'ds-button ask-send', 'data-variant': pick ? 'primary' : 'secondary', disabled: !pick || sending, text: sending ? tr('asks.sending') : chosen ? (chosen === FIXED_CHOICE.key ? tr('asks.send.none') : tr('asks.send', { c: chosen })) : pick ? tr('asks.send.rec', { c: pick }) : tr('asks.pick') });
  send.addEventListener('click', () => answer(it, pick, memo.value.trim()));
  const err = S.err.get(keyOf(it));
  const bg = lines.filter((l) => !FRONT.has(l.dataset.label));
  const card = h('article', { class: 'ask-item', id: it.card, 'aria-label': tr('asks.item', { card: it.card }) },
    h('div', { class: 'ask-meta' },
      SAMPLE ? h('span', { class: 'ds-badge', 'data-tone': 'warning', text: tr('asks.sample') }) : null,
      h('span', { class: 'ds-badge', 'data-tone': it.kind === 'conflict' ? 'danger' : 'info', text: tr(it.kind === 'conflict' ? 'asks.kind.conflict' : 'asks.kind.taste') }),
      h('span', { class: 'ask-app', text: it.app }), h('span', { class: 'ask-age', text: ago(it.asked_at) })),
    h('h2', { class: 'ask-title', text: it.title, title: it.card }),
    // The decision leads: what to pick and the recommendation stay open; what was decided before, what this input wants
    // and what the code does now fold under Background (the reasons are one tap away, not in front of the options).
    h('dl', { class: 'ask-lines' }, lines.filter((l) => FRONT.has(l.dataset.label))),
    h('div', { class: 'ask-choices', role: 'group', 'aria-label': tr('asks.choices') }, buttons),
    memo,
    send,
    err ? h('p', { class: 'ask-err', role: 'alert', text: tr('asks.err', { e: err }) }) : null);
  // One structure on every width: the card, then its background. Wide screens lay them side by side (background open
  // beside the card); narrow ones stack them, background folded under the card (asks.css).
  return h('div', { class: 'ask-split' }, card, bg.length ? h('aside', { class: 'ask-aside', 'aria-label': tr('asks.bg') }, bgFold(it, bg)) : null);
}

function render() {
  main.replaceChildren();
  if (S.error) {
    main.dataset.state = 'error';
    const again = h('button', { type: 'button', class: 'ds-button', 'data-variant': 'secondary', text: tr('asks.retry') });
    again.addEventListener('click', load);
    main.append(h('div', { class: 'ask-empty' }, h('p', { text: tr('asks.loadfail') }), again));
    return;
  }
  if (!S.doc) { main.dataset.state = 'loading'; main.append(h('div', { class: 'ask-item skeleton', 'aria-hidden': 'true' })); return; }
  const items = S.doc.items.filter((i) => !S.done.has(keyOf(i)));
  main.dataset.state = items.length ? 'ready' : 'empty';
  const done = [...S.done.values()].map((d) => h('p', { class: 'ask-done', role: 'status', text: d }));
  main.append(h('p', { class: 'ask-count', text: items.length ? tr('asks.count', { n: items.length }) : '' }), ...done);
  if (!items.length) { main.append(h('div', { class: 'ask-empty' }, h('p', { class: 'ask-clear', text: tr('asks.clear') }), h('p', { class: 'ask-note', text: tr('asks.clear.note') }))); return; }
  for (const it of items) main.append(item(it));
}

// ---------- answering ----------
let CSRF = '';
async function csrf() {
  if (CSRF) return CSRF;
  try { const r = await fetch('/api/session', { credentials: 'same-origin' }); if (r.ok) CSRF = (await r.json()).csrf || ''; } catch { /* asked again on 401 */ }
  return CSRF;
}
function login() {
  return new Promise((resolve) => {
    const input = h('input', { class: 'ds-input', type: 'password', name: 'passphrase', autocomplete: 'current-password', required: true, 'aria-label': tr('login.ph'), placeholder: tr('login.ph') });
    const err = h('p', { class: 'ask-err', role: 'alert', hidden: true });
    const cancel = h('button', { type: 'button', class: 'ds-button', 'data-variant': 'ghost', text: tr('btn.cancel') });
    const form = h('form', {}, h('h3', { text: tr('login.title') }), input, err, h('div', { class: 'actions' }, cancel, h('button', { type: 'submit', class: 'ds-button', 'data-variant': 'primary', text: tr('login.go') })));
    const d = h('dialog', { class: 'login ds-card' }, form);
    document.body.append(d);
    const done = (ok) => { d.close(); d.remove(); resolve(ok); };
    cancel.addEventListener('click', () => done(false));
    d.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      let r; let data = {};
      try {
        r = await fetch('/api/session', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'passphrase', passphrase: input.value }) });
        data = await r.json().catch(() => ({}));
      } catch { r = { ok: false, status: 0 }; }
      if (r.ok) { CSRF = data.csrf || ''; return done(true); }
      err.textContent = r.status === 401 ? tr('login.bad') : (data.error || tr('asks.offline')); err.hidden = false; input.value = ''; input.focus();
    });
    d.showModal(); input.focus();
  });
}
async function post(card, body) {
  return fetch(`/api/asks/${encodeURIComponent(card)}/answer`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'user', 'X-Dasks-CSRF': await csrf() }, body: JSON.stringify(body) });
}
async function answer(it, choice, comment) {
  if (!choice || S.sending.has(keyOf(it))) return;
  if (SAMPLE) { S.err.set(keyOf(it), tr('asks.sample.nosend')); render(); return; }
  const { ask, revision, scope } = it.request;
  const body = { ask, revision, scope, choice, ...(comment ? { comment } : {}) };
  S.sending.add(keyOf(it)); S.err.delete(keyOf(it)); render();
  let why = '';
  try {
    let res = await post(it.card, body);
    if (res.status === 403) { CSRF = ''; res = await post(it.card, body); }
    if (res.status === 401) { CSRF = ''; res = (await login()) ? await post(it.card, body) : null; }
    const data = res ? await res.json().catch(() => ({})) : {};
    const eff = ['proceed', 'respec', 'cancel'].includes(data.effect) ? tr(`asks.eff.${data.effect}`) : tr('asks.eff.done');
    if (res?.ok) { S.done.set(keyOf(it), tr('asks.done', { title: it.title, c: choice, e: eff })); S.pick.delete(keyOf(it)); }
    else why = res ? (data.error || `HTTP ${res.status}`) : tr('asks.nologin');
  } catch { why = tr('asks.offline'); }
  S.sending.delete(keyOf(it));
  if (why) S.err.set(keyOf(it), why);
  render();
  if (!why) load();
}

// A made-up example ask (the user-ask.js validateAsk shape), shown on the sample page.
const SAMPLE_ASK = {
  kind: 'conflict', before: { quote: 'Contact form mails go to one shared inbox', date: '2026-01-15' },
  wants: 'Send each form to the team picked in a dropdown', code: { behavior: 'the form posts to one fixed address', at: 'src/contact/send.ts:12' },
  options: [{ key: 'A', text: 'Keep one inbox; save the dropdown as an idea', effect: 'proceed' }, { key: 'B', text: 'Rewrite the card for per-team routing', effect: 'respec' }],
  rec: { key: 'A', why: 'matches what was decided and how the code works today' },
};
const SAMPLE_DOC = {
  items: [{ card: 'demo.t-ask', title: 'Example: route contact mails by team', app: 'demo', kind: 'conflict', asked_at: new Date(Date.now() - 12 * 60_000).toISOString(),
    lines: askLines(SAMPLE_ASK), options: SAMPLE_ASK.options, rec: SAMPLE_ASK.rec, request: { ask: 'k1', revision: 1, scope: '', choices: ['A', 'B', FIXED_CHOICE.key] } }],
};

const typing = () => !!document.activeElement?.closest?.('.ask-memo');
/** background: a periodic refresh, which never redraws while a memo is being typed (checked again after the fetch). */
async function load(background = false) {
  if (SAMPLE) { S.doc = SAMPLE_DOC; S.error = false; render(); return; }
  let doc = null; let error = false;
  try {
    const r = await fetch('/api/asks', { credentials: 'same-origin' });
    if (!r.ok) throw new Error(String(r.status));
    doc = await r.json();
  } catch { error = true; }
  if (background && typing()) return; // the next refresh draws it
  if (doc) S.doc = doc; S.error = error;
  render();
  // Linked from a card on Today (/asks#<card id>): bring that decision into view the first time it is drawn, then leave
  // the scroll position to the reader (later reloads keep it).
  const id = decodeURIComponent(location.hash.slice(1));
  const target = id && !S.jumped ? document.getElementById(id) : null;
  if (target) { S.jumped = true; target.scrollIntoView({ block: 'start' }); }
}
render();
load();
// Not while a memo is being typed: render() rebuilds the list and the field would lose focus mid-word.
setInterval(() => { if (!document.hidden && !S.sending.size && !typing()) load(true); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !S.sending.size) load(true); });

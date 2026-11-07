// Dasks UI: plain JS, no build step. All server text is escaped before it touches innerHTML.
// Board views live under /#/…; each project (goal) has a read-only page at /p/<app> laid out by its view config.
// Every word of UI copy comes from DICT (public/i18n.js) through t(); card titles through tt() (title_ko / title_en,
// falling back to the original title). Language: ?lang=ko|en, else the saved choice, else English.
'use strict';

const STATUSES = ['todo', 'doing', 'review', 'done', 'blocked-on-user'];
const MS_STATUSES = ['planned', 'active', 'done', 'blocked'];
const LANES = ['claude', 'codex', 'none'];
/** Lane picker: the server's allowed list (else the built-ins), plus the card's own lane so a select never drops it. */
const laneOptions = (cur) => { const l = Array.isArray(S.data?.lanes) && S.data.lanes.length ? S.data.lanes : LANES; return l.includes(cur) ? l : [cur, ...l]; };
/** The board's projects in config order. */
const APP_ORDER = () => ((S.data && S.data.projects) || []).map((p) => p.id);
// Proper nouns stay as they are in both languages; other goals take the short part of their (translated) title.
const PROPER = { north: 'North Star' };

// ---------- storage + language ----------
function stored(k) { try { return localStorage.getItem(k); } catch { return null; } }
function store(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: keep it for this page only */ } }
function forget(k) { try { localStorage.removeItem(k); } catch { /* no storage: nothing to remove */ } }
/** View state saved under the 1.0.0 key names (gb.*) moves to dasks.* once, so nobody loses their scope and folds. */
for (const k of ['expanded', 'scope', 'mode']) {
  const old = stored(`gb.${k}`);
  if (old === null) continue;
  if (stored(`dasks.${k}`) === null) store(`dasks.${k}`, old);
  forget(`gb.${k}`);
}
const LANG_KEY = 'dasks.lang';
let LANG = (() => {
  let q = null;
  try { q = new URLSearchParams(location.search).get('lang'); } catch { /* none */ }
  if (q === 'ko' || q === 'en') { store(LANG_KEY, q); return q; }
  const s = stored(LANG_KEY);
  return s === 'en' || s === 'ko' ? s : 'en';
})();
/** UI copy for `key` in the current language ({name} filled from vars). */
function t(key, vars) {
  const d = DICT[LANG] || DICT.en;
  let s = Object.hasOwn(d, key) ? d[key] : Object.hasOwn(DICT.en, key) ? DICT.en[key] : key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  return s;
}
/** Markdown links show their text (a link cut off at the end too). Display only: the stored card is never changed. */
const readable = (text) => String(text ?? '').replace(/\[([^\]\n]+)\]\((?:[^()\s]|\([^()\s]*\))+\)/g, '$1').replace(/\[([^\]\n]+)\]\([^)\s]*$/, '$1');
/** A whitespace-free path that is not a URL: starts with /, ~/, ./ or ../, or has a / and ends in a file extension. */
const isPathToken = (w) => !/\s/.test(w) && !/^https?:\/\//.test(w) && (/^(?:\/|~\/|\.\.?\/)/.test(w) || (w.includes('/') && /\.[A-Za-z0-9]{1,5}$/.test(w)));
/** A line a machine wrote, not a person: "RESULT …"/"STATUS …"-style words, a lone path or "key: path", an
 *  "$ " command or a timestamp with seconds. A sentence that only mentions a path is not one. */
function isLogLine(line) {
  // a board note line ("- 2026-01-15 08:18 codex@desktop: RESULT: …") is judged by what comes after its prefix
  const s = String(line ?? '').trim().replace(/^-\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s+[^:\s]{1,40}:\s*/, '');
  if (!s) return false;
  const kv = /^https?:\/\//.test(s) ? null : /^[a-z][a-z0-9_-]*:\s*(\S+)$/.exec(s); // a URL is not "key: path"
  return /^(?:RESULT|STATUS|VERDICT|ERROR|FAILED|FAIL|QUEUED|BLOCKED|NEEDS-SPEC|NEEDS-EVIDENCE)\b/.test(s)
    || (kv !== null && isPathToken(kv[1])) || isPathToken(s)
    || s.startsWith('$ ') || /^\[?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s);
}
/** Text without its log lines: { plain (the other lines, trimmed), hidden (how many lines were dropped) }. */
function foldLog(text) {
  const lines = String(text ?? '').split('\n');
  const kept = lines.filter((l) => !isLogLine(l));
  return { plain: kept.join('\n').trim(), hidden: lines.length - kept.length };
}
/** One line that says what a card is about: its now line (unless it is a log line), else the user's quoted words in its
 *  "## Why" section, else ''. At most 160 characters. */
function cardLead(x) {
  const now = String(x?.now ?? '').trim();
  let lead = now && x.now_lint !== 'log' && !isLogLine(now) ? now : '';
  if (!lead) {
    const lines = String(x?.body ?? '').split('\n');
    const start = lines.findIndex((l) => l.trimEnd() === '## Why');
    if (start >= 0) {
      const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
      const why = lines.slice(start + 1, end < 0 ? lines.length : end);
      const from = why.findIndex((l) => l.startsWith('>'));
      if (from >= 0) {
        const to = why.findIndex((l, i) => i > from && !l.startsWith('>'));
        lead = readable(why.slice(from, to < 0 ? why.length : to).map((l) => l.trimEnd().replace(/^> ?/, '')).join(' ')).trim();
      }
    }
  }
  return lead.length > 160 ? `${lead.slice(0, 159)}…` : lead;
}
/** The first line of a card's result once its log lines are folded, else ''. */
function resultLine(x) {
  return foldLog(x?.result).plain.split('\n')[0].trim();
}
/** A card's title in the current language, else its original title (markdown links as their text). */
const tt = (o) => readable((o && (o[`title_${LANG}`] || o.title)) || '').trim();
const stLabel = (s) => t(`st.${s}`);
/** Stored values shown as words: a known value gets its label, anything else shows as is. */
const enumLabel = (prefix, v) => (Object.hasOwn(DICT.en, `${prefix}.${v}`) ? t(`${prefix}.${v}`) : String(v ?? ''));

function setLang(l) {
  if (l !== 'ko' && l !== 'en') return;
  LANG = l; store(LANG_KEY, l);
  // The tap wins over a ?lang= in the address from now on.
  try { const u = new URL(location.href); if (u.searchParams.has('lang')) { u.searchParams.delete('lang'); history['replace' + 'State'](null, '', u.pathname + u.search + u.hash); } } catch { /* no URL API */ }
  applyStatic(); renderAuth(); render();
}
function applyStatic() {
  document.documentElement.lang = LANG;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.setAttribute('title', t(el.dataset.i18nTitle));
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === LANG));
  for (const s of document.querySelectorAll('.nav-more span[data-base]')) delete s.dataset.base; // relabelled just above
  window.DasksChrome?.syncMore(); // the More button names the open page again, in the new language
}

const S = {
  data: null, view: null, selected: null, expanded: new Set(JSON.parse(stored('dasks.expanded') || 'null') || []),
  scope: stored('dasks.scope') || 'all', mode: stored('dasks.mode') || (window.matchMedia?.('(max-width: 760px)').matches ? 'list' : 'board'), q: '',
  link: null, commenting: null, ideas: null,
  more: new Set(), // lists and board columns the user expanded (keys per list; reset on reload)
  boardDone: false, boardStuck: false,
  archive: stored('dasks.archive') === '1', // show archived cards (old done, cancelled)
  // Home project progress: the one open count list ({ app, kind }), the open record folders, the phone's record drawer
  prog: null, folders: new Set(), drawer: false,
};

// ---------- utils ----------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';
/** What a your-turn card asks, the same rule on every screen. */
function turnAsk(x) {
  const row = (k) => { const c = ctxOf(x); const r = c && c.rows.find(([key]) => key === k); return r ? String(r[1]).trim() : ''; };
  if (x.status === 'review') return row('Do') || String(x.pr_summary ?? '').trim() || firstLine(x.result).trim();
  return String(x.needs_user ?? '').trim() || row('Do');
}
const appOf = (id) => String(id).split('.')[0];
const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
const pctBar = (pct, late) => `<span class="ds-progress bar${late ? ' late' : ''}" role="img" aria-label="${clamp(pct)}%"><span class="ds-progress-fill" style="--value:${clamp(pct)}%"></span></span>`;
/** Progress ring (ds-ring): the number sits inside. */
const ring = (pct, big) => `<span class="ds-ring${big ? ' ring-lg' : ''}" style="--value:${clamp(pct)}" role="img" aria-label="${clamp(pct)}%"><svg viewBox="0 0 36 36" aria-hidden="true"><circle class="ds-ring-track" cx="18" cy="18" r="15.9" pathLength="100"/><circle class="ds-ring-fill" cx="18" cy="18" r="15.9" pathLength="100"/></svg><span class="ds-ring-label">${clamp(pct)}%</span></span>`;
const PRIO = { p0: ['urgent', '!'], p1: ['high', '↑'], p2: ['medium', '·'], p3: ['low', '↓'] };
const prioIcon = (p) => { const [lv, ch] = PRIO[p] || PRIO.p3; const l = `${t(`prio.${lv}`)} (${p || 'p3'})`; return `<span class="ds-priority" data-level="${lv}" role="img" aria-label="${esc(l)}" title="${esc(l)}">${ch}</span>`; };
/** One quiet line that says what the priority marks mean, for the priorities a list shows. */
const prioLegend = (items) => {
  const used = Object.keys(PRIO).filter((p) => items.some((x) => (PRIO[x.priority] ? x.priority : 'p3') === p));
  return used.length ? `<p class="prio-legend">${used.map((p) => `<span>${prioIcon(p)}${esc(t(`prio.${PRIO[p][0]}`))}</span>`).join('')}</p>` : '';
};
const claimChip = (x) => (x.claimed_by && x.status !== 'done' && x.status !== 'cancelled'
  ? `<span class="chip claim" title="${esc(x.claimed_by)} · ${esc((x.claimed_at || '').slice(0, 16).replace('T', ' '))}">● ${esc(x.claimed_by)}${x.claimed_at ? ` · ${ago(x.claimed_at)}` : ''}</span>` : '');
const stamp = (iso) => esc(String(iso || '').slice(0, 16).replace('T', ' '));
function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return t('unit.m', { n: Math.max(m, 0) });
  const h = Math.round(m / 60);
  return h < 48 ? t('unit.h', { n: h }) : t('unit.d', { n: Math.round(h / 24) });
}
const agoText = (iso) => t('ago', { t: ago(iso) });
function toast(msg, err = false) {
  const el = $('#toast');
  el.textContent = msg; el.className = 'toast' + (err ? ' err' : ''); el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, err ? 6000 : 2200);
}
// The board UI is the user, but only once logged in: every write carries the session cookie (HttpOnly, sent by the
// browser) and this session's CSRF token. A 401 asks for the passphrase, then retries once.
let CSRF = '';
async function csrfToken() {
  if (CSRF) return CSRF;
  const r = await fetch('/api/session', { credentials: 'same-origin' });
  if (r.ok) CSRF = (await r.json()).csrf || '';
  return CSRF;
}
async function api(path, body, retried = false) {
  const opts = body === undefined ? {} : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'user', 'X-Dasks-CSRF': await csrfToken() }, body: JSON.stringify(body) };
  const r = await fetch(path, opts);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (body !== undefined && !retried && data && typeof data === 'object') {
    if (r.status === 401 && data.login) { CSRF = ''; await login(); return api(path, body, true); }
    if (r.status === 403 && /CSRF/.test(data.error || '')) { CSRF = ''; return api(path, body, true); } // token of an older session
  }
  if (!r.ok) { const err = new Error((data && data.error) || `HTTP ${r.status}`); err.status = r.status; err.data = data; err.rule = data && data.rule; throw err; }
  return data;
}
// ---------- header login button ----------
// The board asks for the passphrase when something is first changed; the header button lets the human log in (or out)
// up front. Its state comes from GET /api/session (cookie only; 401 = not logged in).
let AUTH = { known: false, in: false, until: '' };
async function refreshAuth() {
  try {
    const r = await fetch('/api/session', { credentials: 'same-origin' });
    const d = await r.json().catch(() => ({}));
    AUTH = { known: true, in: r.ok && d.logged_in === true, until: d.expires_at || '' };
    if (AUTH.in && d.csrf) CSRF = d.csrf;
  } catch { AUTH = { ...AUTH, known: false }; }
  renderAuth();
}
function renderAuth() {
  syncSpecButtons(); // the open card's Spec block button follows the login, in place (an unsaved form stays as typed)
  const b = document.getElementById('auth-btn');
  if (!b) return;
  b.hidden = !AUTH.known;
  b.dataset.state = AUTH.in ? 'in' : 'out';
  b.textContent = t(AUTH.in ? 'auth.logout' : 'auth.login');
  const until = AUTH.in && AUTH.until ? new Date(AUTH.until) : null;
  b.title = AUTH.in ? t('auth.in', { d: until && !Number.isNaN(until.getTime()) ? until.toLocaleDateString(LANG === 'ko' ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric' }) : '' }) : t('login.why');
}
async function authClick() {
  await refreshAuth(); // the session may be gone meanwhile (server restart, expiry): act on the real state
  if (AUTH.in) {
    // Not through api(): a 401 here means "already logged out", never "ask for the passphrase".
    let status = 0;
    try { status = (await fetch('/api/session/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'user', 'X-Dasks-CSRF': CSRF }, body: '{}' })).status; } catch { status = 0; }
    if (status === 200 || status === 401) { CSRF = ''; toast(t('auth.out')); } else toast(t('auth.outfail'), true);
  } else {
    try { await login(); toast(t('auth.ok')); } catch { /* closed */ }
  }
  await refreshAuth();
}

/** Passphrase dialog. Resolves once logged in; rejects (status 401) when closed. */
function login() {
  return new Promise((resolve, reject) => {
    const d = document.createElement('dialog');
    d.className = 'login ds-card';
    d.innerHTML = `<form><h3>${esc(t('login.title'))}</h3><p class="ds-muted">${esc(t('login.why'))}</p>
      <input class="ds-input" type="password" name="passphrase" autocomplete="current-password" required aria-label="${esc(t('login.ph'))}" placeholder="${esc(t('login.ph'))}">
      <p class="login-err" role="alert" hidden></p>
      <div class="actions"><button type="button" class="ds-button" data-variant="ghost" data-login="cancel">${esc(t('btn.cancel'))}</button><button type="submit" class="ds-button" data-variant="primary">${esc(t('login.go'))}</button></div></form>`;
    document.body.append(d);
    const form = d.querySelector('form'); const err = d.querySelector('.login-err');
    const done = (ok) => { d.close(); d.remove(); if (ok) resolve(); else reject(Object.assign(new Error(t('login.cancelled')), { status: 401 })); };
    d.querySelector('[data-login=cancel]').addEventListener('click', () => done(false));
    d.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      let r; let data = {};
      try {
        r = await fetch('/api/session', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'passphrase', passphrase: form.passphrase.value }) });
        data = await r.json().catch(() => ({}));
      } catch { r = { ok: false, status: 0 }; }
      if (r.ok) { CSRF = data.csrf || ''; AUTH = { known: true, in: true, until: data.expires_at || '' }; renderAuth(); return done(true); }
      err.textContent = r.status === 401 ? t('login.bad') : r.status === 429 ? t('login.locked') : r.status === 503 ? t('login.off') : (data.error || t('login.failed'));
      err.hidden = false; form.passphrase.value = ''; form.passphrase.focus();
    });
    d.showModal(); form.passphrase.focus();
  });
}

// ---------- data access ----------
const D = {
  task: (id) => S.data.tasks.find((x) => x.id === id),
  goal: (id) => S.data.goals.find((g) => g.id === id),
  milestone: (id) => { for (const g of S.data.goals) { const m = g.milestones.find((x) => x.id === id); if (m) return m; } return null; },
  roll: (id) => {
    for (const g of S.data.rollup.goals) { if (g.id === id) return g; const m = g.milestones.find((x) => x.id === id); if (m) return m; }
    return null;
  },
  node: (id) => {
    if (id === 'north') return { kind: 'northstar', title: tt(S.data.northstar) || PROPER.north, obj: S.data.northstar };
    const g = D.goal(id); if (g) return { kind: 'goal', title: tt(g), obj: g };
    const m = D.milestone(id); if (m) return { kind: 'milestone', title: tt(m), obj: m };
    const x = D.task(id); if (x) return { kind: 'task', title: tt(x), obj: x };
    return null;
  },
  // Configured projects first (config order), then any other goal by id — the same order the server uses.
  goals: () => [...S.data.goals].sort((a, b) => rank(APP_ORDER(), a.id) - rank(APP_ORDER(), b.id) || a.id.localeCompare(b.id)),
};
const rank = (order, id) => (order.includes(id) ? order.indexOf(id) : order.length);
/** Project pages in nav order: the configured projects, then any other goal by id. */
const projects = () => S.data.goals.map((g) => g.id).sort((a, b) => rank(APP_ORDER(), a) - rank(APP_ORDER(), b) || a.localeCompare(b));
const shortTitle = (g) => String(tt(g)).split(/\s+—\s+/)[0];
const tagOf = (g) => String(tt(g)).split(/\s+—\s+/).slice(1).join(' — ');
function appName(id) {
  const named = ((S.data && S.data.projects) || []).find((p) => p.id === id);
  if (named && named.name) return named.name;
  const g = S.data && D.goal(id);
  return g ? shortTitle(g) : id;
}

// /p/<app>: a project page. Humans only look here; agents shape it through /api/views/<app> and /api/ideas/<app>.
const PAGE = (location.pathname.match(/^\/p\/([a-z0-9-]+)\/?$/) || [])[1] || null;

let loadSeq = 0;
let loadsInFlight = 0; // timers skip a tick while any load() is running, so they never supersede a live reload
async function load() {
  refreshAuth();
  const seq = ++loadSeq;
  const enc = PAGE ? encodeURIComponent(PAGE) : '';
  loadsInFlight++;
  let data, view, ideas;
  try {
    [data, view, ideas] = await Promise.all([
      api('/api/board'), PAGE ? api(`/api/views/${enc}`) : null, PAGE ? api(`/api/ideas/${enc}`).catch(() => null) : null,
    ]);
  } finally { loadsInFlight--; }
  if (seq !== loadSeq) return; // a newer load started meanwhile: never paint older data over it
  S.data = data; S.pview = view; S.ideas = ideas;
  // The daily summary and (on its page) the review triage: a failure keeps the last copy and never stops the board.
  if (!PAGE) {
    const [sum, tri] = await Promise.all([api('/api/summary').catch(() => null), S.view === 'review' ? api('/api/review-triage').catch(() => null) : null]);
    if (seq !== loadSeq) return;
    if (sum) S.summary = sum.summary;
    if (tri) S.triage = tri;
  }
  render();
}
/** Live changes come in bursts (a write, then the file watcher): one reload per burst. */
function reloadSoon() {
  // A hidden tab does not refetch the board on every change; it catches up once when it is shown again.
  if (document.hidden) { reloadSoon.missed = true; return; }
  clearTimeout(reloadSoon.t); reloadSoon.t = setTimeout(() => load().catch(() => {}), 300);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && reloadSoon.missed) { reloadSoon.missed = false; reloadSoon(); } });

// ---------- routing ----------
function route() {
  if (PAGE) { S.view = 'project'; render(); return; }
  // #/card/<id>: a link to one card. Opens it on Goals, like "goto".
  const card = (location.hash.match(/^#\/card\/([^?#/]+)/) || [])[1];
  if (card) {
    let id = card;
    try { id = decodeURIComponent(card); } catch { /* keep as written */ }
    S.selected = id; S.link = null; S.keepSelection = true; S.expanded.add(appOf(id));
    const x = S.data && D.task(id); if (x) S.expanded.add(x.milestone);
    location.replace('#/goals');
    return;
  }
  const v = (location.hash.match(/^#\/(\w+)/) || [])[1];
  const views = ['home', 'goals', 'today', 'board', 'connections', 'review'];
  const prev = S.view;
  S.view = views.includes(v) ? v : 'home';
  if (prev === 'home' && S.view !== 'home') S.drawer = false;
  if (prev && prev !== S.view && !S.keepSelection) closePanel(true);
  S.keepSelection = false;
  for (const a of document.querySelectorAll('[data-view]')) a.setAttribute('aria-current', a.dataset.view === S.view ? 'page' : 'false');
  window.DasksChrome?.syncMore();
  if (S.view === 'review' && prev !== 'review') api('/api/review-triage').then((x) => { S.triage = x; if (S.view === 'review') render(); }).catch(() => {});
  render();
}

function render() {
  if (!S.data) return;
  renderChrome();
  const main = $('#main');
  const y = window.scrollY;
  // A project page keeps an open panel across live reloads, like the board views.
  if (S.view === 'project') { main.innerHTML = viewProject(); window.scrollTo(0, y); if (S.selected) renderPanel(); else closePanel(false); return; }
  // A comment being typed on Today survives the re-render (live updates arrive every few seconds).
  const ta = $('form[data-form="comment"] textarea', main);
  const typing = ta && { id: ta.closest('form').dataset.id, value: ta.value, focus: document.activeElement === ta, a: ta.selectionStart, b: ta.selectionEnd };
  const qbox = document.activeElement?.matches?.('.board-q') ? { a: document.activeElement.selectionStart, b: document.activeElement.selectionEnd } : null;
  if (qbox && S.composing) return; // a live reload while a Korean syllable is being typed waits for the next one
  main.innerHTML = S.view === 'home' ? viewHome() : S.view === 'today' ? viewToday() : S.view === 'board' ? viewBoard() : S.view === 'connections' ? viewConnections() : S.view === 'review' ? viewReview() : viewGoals();
  if (typing) {
    const again = document.querySelector(`form[data-form="comment"][data-id="${CSS.escape(typing.id)}"] textarea`);
    if (again) { again.value = typing.value; if (typing.focus) { again.focus(); again.setSelectionRange(typing.a, typing.b); } }
  }
  if (qbox) { const q = $('.board-q', main); if (q) { q.focus({ preventScroll: true }); q.setSelectionRange(qbox.a, qbox.b); } }
  window.scrollTo(0, y);
  if (S.selected && (S.view === 'home' || S.view === 'goals' || S.view === 'board' || S.view === 'today')) renderPanel();
  else if (S.view === 'connections' && S.link !== null) renderLinkPanel();
  else if (S.view === 'connections' && S.selected) renderPanel(); // a card opened from the done ticker stays open on reloads
  else closePanel(false);
}

function renderChrome() {
  const n = needsYou().length;
  // Project pages replace the nav (no badges there), so only touch the badges that exist.
  for (const b of [$('#badge-top'), $('#badge-bottom')].filter(Boolean)) { b.textContent = n; b.hidden = !n; }
  // /asks draws the same top bar from this snapshot (chrome.js), so its badge matches.
  store('dasks.chrome', JSON.stringify({ at: Date.now(), n }));
  renderDoneTicker();
  renderSummary();
}

/** Daily summary: written by the board once a day (GET /api/summary); shown here until this browser dismisses that one
 *  (localStorage 'dasks.summarySeen' = the dismissed summary's time). */
const SUM_KEY = 'dasks.summarySeen';
const SUM = { open: false, seen: '' };
/** The steps unattended runs left for the human; empty when there are none. Each row opens its card. */
const sumSkipped = (xs) => (xs.length ? `<h3>${esc(t('sum.skipped', { n: xs.length }))}</h3><ul class="tick-list">${xs.map((x) => `<li><button type="button" class="tick-card sum-skip" data-action="select" data-id="${esc(x.id)}"><span class="tick-title">${esc(x.title)}</span><span class="sum-step">${esc(x.step)}${x.why ? ` · ${esc(x.why)}` : ''}</span></button></li>`).join('')}</ul>` : '');
function renderSummary() {
  const el = $('#day-summary'), s = S.summary;
  if (!el) return;
  if (!s || s.at === (stored(SUM_KEY) || SUM.seen)) { el.hidden = true; el.innerHTML = ''; return; }
  const w = s.waiting, waiting = w.asks.length + w.approve.length + w.blocked.length;
  const fails = s.failures.length + s.warnings.length, stuck = s.stuck.machines.length + s.stuck.cards.length;
  const skipped = s.skipped || [];   // a summary written before this field has none
  const nums = [['sum.done', s.finished.length], ['sum.waiting', waiting], ['sum.stuck', stuck], ['sum.failures', fails], ...(skipped.length ? [['sum.skips', skipped.length]] : [])]
    .map(([k, n]) => `<span class="sum-n${n && k !== 'sum.done' ? ' warn' : ''}">${esc(t(k, { n }))}</span>`).join('');
  const cards = (xs) => xs.map((x) => `<li><button type="button" class="tick-card" data-action="select" data-id="${esc(x.id)}"><span class="tick-title">${esc(x.title)}</span>${x.hours ? `<span class="tick-ago">· ${esc(t('sum.nonews', { n: x.hours }))}</span>` : ''}</button></li>`).join('');
  const part = (k, xs) => (xs.length ? `<h3>${esc(t(k, { n: xs.length }))}</h3><ul class="tick-list">${cards(xs)}</ul>` : '');
  const more = SUM.open ? `<div class="sum-more">${part('sum.finished', s.finished)}${part('sum.asks', w.asks)}${part('sum.approve', w.approve)}${part('sum.blocked', w.blocked)}${sumSkipped(skipped)}
    ${s.stuck.machines.length ? `<h3>${esc(t('sum.machines', { n: s.stuck.machines.length }))}</h3><ul class="tick-list">${s.stuck.machines.map((m) => `<li>${esc(m.machine)} · ${esc(agoText(m.last_seen))}</li>`).join('')}</ul>` : ''}
    ${part('sum.stale', s.stuck.cards)}
    ${fails ? `<h3>${esc(t('sum.failed', { n: fails }))}</h3><ul class="tick-list">${s.failures.map((f) => `<li><button type="button" class="tick-card" data-action="select" data-id="${esc(f.id)}"><span class="tick-title">${esc(f.id)}</span><span class="tick-ago">${esc(f.note)}</span></button></li>`).join('')}${s.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>` : '';
  el.innerHTML = `<div class="sum-head"><b>${esc(t('sum.title', { day: s.day }))}</b>${nums}</div><div class="tick-acts"><button type="button" class="tick-more" data-action="sum-more" aria-expanded="${SUM.open}">${esc(t(SUM.open ? 'done.tick.less' : 'sum.open'))}</button><button type="button" class="ds-button tick-seen" data-variant="secondary" data-size="sm" data-action="sum-ok">${esc(t('done.tick.ok'))}</button></div>${more}`;
  el.hidden = false;
}

/** Review triage (More, then Review): every card in review with a PR, in the buckets a person clears in this order. The
 *  server sorts (src/lib/triage.ts, GET /api/review-triage); this only draws it. Read-only. */
function viewReview() {
  const r = S.triage;
  const head = `<div class="view-head"><h1>${esc(t('rv.title'))}</h1></div><p class="rv-note">${esc(t('rv.note', { n: r ? r.stale_days : 3 }))}</p>`;
  if (!r) return `${head}<p class="loading">${esc(t('loading'))}</p>`;
  if (!r.total) return `${head}<p class="empty">${esc(t('rv.none'))}</p>`;
  const ci = (x) => `<span class="chip rv-ci" data-ci="${esc(x.ci)}">${esc(t(`rv.ci.${x.ci}`))}</span>`;
  const row = (x) => `<li class="rv-row"><button type="button" class="tick-card" data-action="select" data-id="${esc(x.id)}"><span class="chip app">${esc(appName(x.goal))}</span><span class="tick-title">${esc(tt(D.task(x.id) || x))}</span></button>
    <span class="rv-meta">${ci(x)}<span class="chip">${esc(t(`rv.rev.${x.review}`))}</span><a href="${esc(x.pr)}" target="_blank" rel="noopener noreferrer">#${esc(x.pr.split('/').pop())}</a><span class="rv-why">${esc(x.why)}</span></span></li>`;
  return head + r.order.map((b) => {
    const xs = r.buckets[b];
    return `<section class="rv-bucket" data-bucket="${esc(b)}"><h2 class="sec-title">${esc(t(`rv.b.${b}`))} · ${xs.length}</h2>${xs.length ? `<ul class="plist">${xs.map(row).join('')}</ul>` : `<p class="empty">${esc(t('rv.empty'))}</p>`}</section>`;
  }).join('');
}

/** Done ticker: one line on every board page listing cards that reached done since this browser last pressed Got it (no
 *  mark yet: the last 24 h; never more than 7 days). Read from the board's own state, so every way to done counts.
 *  public/done-ticker.js (window.DoneTicker) picks the cards; the mark is localStorage 'dasks.doneSeen' (ms). */
const TICK_KEY = 'dasks.doneSeen';
/** open: the list is expanded; mark: the last Got it in this tab, so it still clears the line when storage refuses. */
const TICK = { open: false, mark: 0 };
const tickMark = () => Math.max(Number(stored(TICK_KEY)) || 0, TICK.mark);
function renderDoneTicker() {
  const el = $('#done-ticker'), DT = window.DoneTicker;
  if (!el || !DT) return;
  const items = DT.tickerItems(S.data.tasks, Date.now(), tickMark());
  if (!items.length) { el.hidden = true; el.innerHTML = ''; TICK.open = false; return; }
  const { shown, more } = DT.tickerShown(items, TICK.open);
  const line = ({ x, at }) => {
    const pr = DT.prRef(x.pr);
    return `<li><button type="button" class="tick-card" data-action="select" data-id="${esc(x.id)}"><span class="tick-ok" aria-hidden="true">✓</span><span class="tick-title">${esc(tt(x))}</span>${pr ? `<span class="tick-pr">— ${esc(pr)}</span>` : ''}<span class="tick-ago">· ${esc(agoText(new Date(at).toISOString()))}</span></button></li>`;
  };
  const toggle = more > 0 ? `<button type="button" class="tick-more" data-action="tick-more" aria-expanded="false">${esc(t('done.tick.more', { n: more }))}</button>`
    : TICK.open && items.length > DT.TOP ? `<button type="button" class="tick-more" data-action="tick-more" aria-expanded="true">${esc(t('done.tick.less'))}</button>` : '';
  el.innerHTML = `<ul class="tick-list">${shown.map(line).join('')}</ul><div class="tick-acts">${toggle}<button type="button" class="ds-button tick-seen" data-variant="secondary" data-size="sm" data-action="tick-ok" title="${esc(t('done.tick.ok.title'))}">${esc(t('done.tick.ok'))}</button></div>`;
  el.hidden = false;
}
/** Got it: the mark moves to the newest done time on the line, so the line clears until another card finishes. */
function tickSeen() {
  const DT = window.DoneTicker;
  if (!DT || !S.data) return;
  TICK.mark = DT.markAfter(DT.tickerItems(S.data.tasks, Date.now(), tickMark()), tickMark());
  store(TICK_KEY, String(TICK.mark));
  TICK.open = false;
  renderDoneTicker();
}

// ---------- Home: your turn, goals, running ----------
/** Your turn = blocked-on-user, plus review cards with a non-draft open PR explicitly waiting on the user's OK.
 *  Agent-only review (no user ask / no open PR / draft PR) must not count. */
const waitsOnUser = (x) => typeof x.needs_user === 'string' && x.needs_user.trim().length > 0;
const hasOpenUserPr = (x) => {
  const pr = typeof x.pr === 'string' ? x.pr.trim() : '';
  if (!/^https?:\/\//i.test(pr)) return false;
  const blob = `${pr} ${x.pr_summary || ''}`;
  if (/\b\[draft\]|\bdraft\s+pr\b/i.test(blob)) return false;
  return true;
};
const isTurn = (x) => x.status === 'blocked-on-user'
  || (x.status === 'review' && hasOpenUserPr(x) && waitsOnUser(x));
/** What the user does with a turn: decide (an open ask, or a choice), approve (a PR or a yes), run (do it yourself).
 *  The words are matched in the card's own text, which may be Korean or English. */
const askKind = (s) => (/승인|허락|허용|확인\s*받|\bapprov|\bOK\b|\ballow\b/i.test(s) ? 'approve'
  : /`[^`]+`|실행하|실행해|터미널|명령|보내|보낸다|요청하|복사해|붙여|설치하세요|\brun\b|\bssh\b|\bbash\b/i.test(s) ? 'run' : 'decide');
const turnKind = (x) => (x.user_ask ? 'decide' : x.status === 'review' ? 'approve' : askKind(String(x.needs_user ?? '')));
const TURN_KINDS = ['decide', 'approve', 'run'];
/** "Decide 2 · Approve 6 · Do it yourself 17" for a set of your-turn cards (kinds with none left out). */
const turnParts = (cards) => TURN_KINDS.map((k) => [k, cards.filter((x) => turnKind(x) === k).length]).filter(([, n]) => n).map(([k, n]) => `${t(`turn.${k}`)} ${n}`);
/** The same split as HTML: each "kind n" stays on one line, so a phone never wraps the number away from its kind. */
const turnSplitHtml = (cards) => turnParts(cards).map((p) => `<span class="nw">${esc(p)}</span>`).join(' · ');
/** Your-turn order: p0 first, then the oldest (longest untouched) first. */
const waitFrom = (x) => { const v = Date.parse(x.updated); return Number.isNaN(v) ? Infinity : v; }; // no date: last in its group
function byTurn(a, b) {
  return (a.priority === 'p0' ? 0 : 1) - (b.priority === 'p0' ? 0 : 1)
    || waitFrom(a) - waitFrom(b) || a.id.localeCompare(b.id);
}
const TURN_TOP = 5;
const turnOf = (tasks) => tasks.filter(isTurn).sort(byTurn);

/** A doing card with no start, claim or heartbeat for this long is shown as "stalled?". */
const STALE_MS = 24 * 3600_000;
/** doingAt: the newest of start, claim and claim heartbeat (else the last update). isRunnerCard: the card runner
 *  (`runner@<machine>`) holds the claim; the board gives its cards back when its heartbeat stops. */
const isStale = (x) => x.status === 'doing' && !isRunnerCard(x) && Date.now() - Date.parse(doingAt(x)) > STALE_MS, doingAt = (x) => [x.started_at, x.claimed_at, x.claim_seen].filter((at) => Number.isFinite(Date.parse(at))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || x.updated, isRunnerCard = (x) => /^runner@/.test(x.claimed_by || '');
/** How long a doing card has been doing: from started_at (else its claim, else its last update). */
const doingFor = (x) => ago(x.started_at || x.claimed_at || x.updated);
const runningOrder = (a, b) => (isStale(a) ? 1 : 0) - (isStale(b) ? 1 : 0)
  || (Date.parse(doingAt(a)) || 0) - (Date.parse(doingAt(b)) || 0);

/** "+N more" / "less" under a long list; `key` names the list so each one remembers its own state. */
function moreBtn(key, hidden) {
  if (hidden <= 0 && !S.more.has(key)) return '';
  const open = S.more.has(key);
  return `<button type="button" class="more-link more-btn" data-action="more" data-key="${esc(key)}" aria-expanded="${open}">${esc(open ? t('more.less') : t('more.n', { n: hidden }))}</button>`;
}
const limited = (items, key, top) => (S.more.has(key) ? items : items.slice(0, top));

/** One your-turn row: priority, title, project · what is asked · how long ago. `select` opens the card (board views only). */
function turnRow(x, select) {
  const ask = readable(firstLine(turnAsk(x) || (x.status === 'review' ? t('review.ready') : '')));
  // One row anatomy for a your-turn item on every screen: the kind (decide · approve · run) as the amber tag, the title,
  // then one quiet line (project · question · wait).
  const sub = `<span class="turn-tag">${esc(t(`turn.${turnKind(x)}`))}</span> ${esc(appName(x.goal))}${ask ? ` · ${esc(ask)}` : ''} · ${esc(ago(x.updated))}`;
  const inner = `<span class="ds-row-main"><span class="ds-row-title">${esc(tt(x))}${newMark(x)}</span><span class="ds-row-sub">${sub}</span></span>`;
  return select ? `<button type="button" class="ds-row" data-action="select" data-id="${esc(x.id)}" aria-selected="${S.selected === x.id}">${inner}<span class="ds-row-trailing ico ico-right" aria-hidden="true"></span></button>`
    : `<div class="ds-row">${inner}</div>`;
}
function turnList(items, key, select, top = TURN_TOP) {
  if (!items.length) return `<div class="ds-empty" data-variant="list"><p class="ds-empty-desc">${esc(t('today.noneeds'))}</p></div>`;
  return `<div class="ds-list turn">${limited(items, key, top).map((x) => turnRow(x, select)).join('')}</div>${moreBtn(key, items.length - top)}`;
}

/** Running cards as mission cards: project initial, title, how long; stale ones dimmed with "stalled?". */
function missionCard(x, select) {
  const stale = isStale(x);
  const who = x.claimed_by || (x.lane === 'none' ? x.owner : enumLabel('lane', x.lane));
  const status = isRunnerCard(x) ? `<span class="ds-mission-status" data-state="running">${esc(t('runner.running'))}</span>` : stale ? `<span class="ds-mission-status" data-state="attention">${esc(t('stalled'))}</span>` : `<span class="ds-mission-status" data-state="running">${esc(t('doing.for', { t: doingFor(x) }))}</span>`;
  const head = `<span class="ds-agent-icon" aria-hidden="true">${esc(appName(x.goal).slice(0, 1))}</span><span class="mtitle">${esc(tt(x))}${newMark(x)}</span>${status}`;
  const sub = `<span class="msub">${esc(appName(x.goal))} · ${esc(who)}${stale ? ` · ${esc(t('stalled.since', { t: ago(doingAt(x)) }))}` : ''}</span>`;
  const attrs = `class="ds-mission${stale ? ' stale' : ''}"${stale ? ' data-stale="true"' : ''}`;
  return select ? `<button type="button" ${attrs} data-action="select" data-id="${esc(x.id)}"><span class="ds-mission-head">${head}</span>${sub}</button>`
    : `<div ${attrs}><div class="ds-mission-head">${head}</div>${sub}</div>`;
}
function missionList(items, key, select, top = 5) {
  if (!items.length) return `<div class="ds-empty" data-variant="list"><p class="ds-empty-desc">${esc(t('today.norun'))}</p></div>`;
  return `<div class="ds-stack" data-gap="2">${limited(items, key, top).map((x) => missionCard(x, select)).join('')}</div>${moreBtn(key, items.length - top)}`;
}

/** Late milestones of a goal (due passed, not done), from the roll-up. */
const lateOf = (gid) => (D.roll(gid)?.milestones || []).filter((m) => m.late).length;

function goalCard(app) {
  const g = D.goal(app); if (!g) return '';
  const tasks = appTasks(app);
  const turn = tasks.filter(isTurn).length, run = runningOf(tasks).length, late = lateOf(app);
  const line = tagOf(g);
  // Current milestone = the first one not done; last merge = the newest done card of this goal that has a PR.
  const cur = g.milestones.find((m) => msState(m, D.roll(m.id) || { pct: 0 }) !== 'done');
  const curPct = cur ? clamp((D.roll(cur.id) || { pct: 0 }).pct) : 0;
  const merged = S.data.tasks.filter((x) => x.goal === app && x.status === 'done' && x.pr).sort((a, b) => (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0))[0];
  return `<a class="ds-card goal-card" href="/p/${esc(app)}">
    <span class="goal-top"><span class="goal-name">${esc(appName(app))}</span>${ring(D.roll(app)?.pct ?? 0)}</span>
    ${line ? `<span class="goal-line">${esc(line)}</span>` : ''}
    ${cur ? `<span class="goal-ms">${esc(tt(cur))} · ${curPct}%</span>` : ''}${merged ? `<span class="goal-merge">${esc(t('home.lastmerge', { t: ago(merged.updated) }))}</span>` : ''}
    <span class="counts">${turn ? `<span class="ds-badge" data-tone="warning">${esc(t('home.turn.n', { n: turn }))}</span>` : ''}${run ? `<span class="ds-badge">${esc(t('home.doing.n', { n: run }))}</span>` : ''}${late ? `<span class="ds-badge" data-tone="danger">${esc(t('home.late.n', { n: late }))}</span>` : ''}${!turn && !run && !late ? `<span class="ds-badge" data-variant="outline">${esc(t('p.clear'))}</span>` : ''}</span>
  </a>`;
}
// ---------- Home: project progress rows and the records drawer ----------
// Every number is the length of the id list it opens: progressRow returns the lists, the row draws their lengths and
// the open list draws those same ids, so a count and its list cannot disagree.
const PROG_KINDS = ['turn', 'doing', 'stalled'];
const STALL_REASONS = new Set(['doing-stale', 'review-stale']);
/** One pass over the board: open cards per goal, cards by id, stuck items by id. */
function progIndex() {
  const byGoal = new Map(), byId = new Map();
  for (const x of S.data.tasks) { byId.set(x.id, x); if (x.status === 'cancelled') continue; if (!byGoal.has(x.goal)) byGoal.set(x.goal, []); byGoal.get(x.goal).push(x); }
  const stuck = new Map((S.data.stuck?.items || []).map((item) => [item.id, item]));
  return { byGoal, byId, stuck };
}
/** A project's row: current stage (first milestone not done), and the ids behind your turn · running · stalled. */
function progressRow(app, idx = progIndex()) {
  const g = D.goal(app);
  const tasks = idx.byGoal.get(app) || [];
  const ms = g ? g.milestones : [];
  const cur = ms.find((m) => msState(m, D.roll(m.id) || { pct: 0 }) !== 'done');
  const stage = cur ? { id: cur.id, title: tt(cur), pct: clamp(D.roll(cur.id)?.pct) } : null;
  const turn = turnOf(tasks);
  const turnIds = new Set(turn.map((x) => x.id));
  const stalled = tasks.filter((x) => STALL_REASONS.has(idx.stuck.get(x.id)?.reason) && !turnIds.has(x.id))
    .sort((a, b) => (Date.parse(a.updated) || 0) - (Date.parse(b.updated) || 0) || a.id.localeCompare(b.id));
  return {
    app, stage, allDone: !cur && ms.length > 0,
    turn: turn.map((x) => x.id), doing: runningOf(tasks).map((x) => x.id), stalled: stalled.map((x) => x.id),
  };
}
/** One progress row per project, in nav order. */
function progressRows(idx = progIndex()) { return projects().map((app) => progressRow(app, idx)); }
/** The one plain line a report card shows, by why the card is listed. */
function reportLine(x, why) {
  if (why === 'turn' || (why === 'important' && isTurn(x))) return readable(firstLine(x.needs_user)).trim() || t('prog.line.pr');
  if (why === 'doing' || (why === 'important' && x.status === 'doing')) return t('prog.line.doing', { t: ago(x.started_at || x.updated) });
  if (why === 'stalled') return t('prog.line.stalled', { t: ago(x.updated) });
  return t('prog.line.updated', { t: ago(x.updated) });
}
/** A card as a small report: project · status, title, one plain line, the id small and quiet. Opens the card panel. */
function reportCard(x, line) {
  return `<button type="button" class="rcard ds-card" data-action="select" data-id="${esc(x.id)}"><span class="rc-head"><span class="rc-app">${esc(appName(x.goal))}</span><span class="status st-${esc(x.status)}">${esc(stLabel(x.status))}</span></span><span class="rc-title">${esc(tt(x))}</span>${line ? `<span class="rc-line">${esc(line)}</span>` : ''}<span class="rc-id mono">${esc(x.id)}</span></button>`;
}
const PROG_LABEL = { turn: 'prog.turn', doing: 'prog.doing', stalled: 'prog.stalled' };
/** One count: a button that opens its list when there is something to open, plain text otherwise. */
function progCount(r, kind) {
  const ids = r[kind];
  const n = ids.length;
  const label = `<span class="pr-k">${esc(t(PROG_LABEL[kind]))}</span> <b>${n}</b>`;
  if (!n) return `<span class="pr-n" data-zero data-kind="${kind}" data-n="${n}">${label}</span>`;
  const open = S.prog?.app === r.app && S.prog.kind === kind;
  return `<button type="button" class="pr-n" data-action="prog" data-id="${esc(r.app)}" data-key="${kind}" aria-expanded="${open}" aria-controls="prog-list-${esc(r.app)}" aria-label="${esc(t('prog.open', { app: appName(r.app), what: t(PROG_LABEL[kind]), n }))}" data-kind="${kind}" data-n="${n}">${label}</button>`;
}
function progressRowHtml(r, idx) {
  const label = r.stage ? r.stage.title : t(r.allDone ? 'prog.alldone' : 'prog.nostage');
  const pct = r.stage ? r.stage.pct : r.allDone ? 100 : null;
  const bar = pct === null ? '' : `${pctBar(pct)}<span class="pr-pct">${pct}%</span>`;
  const open = S.prog?.app === r.app ? S.prog.kind : null;
  const list = open ? r[open].map((id) => reportCard(idx.byId.get(id), reportLine(idx.byId.get(id), open))).join('') : '';
  return `<div class="pr-item"><div class="pr-row" data-app="${esc(r.app)}">
    <div class="pr-name"><a class="pr-app" href="/p/${esc(r.app)}">${esc(appName(r.app))}</a><span class="pr-stage">${esc(label)}</span></div>
    <div class="pr-bar">${bar}</div>
    <div class="pr-counts">${PROG_KINDS.map((k) => progCount(r, k)).join('')}</div></div>
    <div class="pr-list" id="prog-list-${esc(r.app)}"${open ? ` role="region" aria-label="${esc(t('prog.list', { app: appName(r.app), what: t(PROG_LABEL[open]) }))}"` : ' hidden'}>${list}</div></div>`;
}
/** Home's last section. An open list whose project is gone or that became empty closes here (live reloads). */
function progressSection() {
  const idx = progIndex();
  const rows = progressRows(idx);
  if (S.prog && !rows.find((r) => r.app === S.prog.app)?.[S.prog.kind]?.length) S.prog = null;
  const body = rows.length ? `<div class="pr-rows">${rows.map((r) => progressRowHtml(r, idx)).join('')}</div>`
    : `<div class="ds-empty" data-variant="list"><p class="ds-empty-desc">${esc(t('prog.none'))}</p></div>`;
  return `<section class="prog"><div class="sec-head"><h2 class="sec-title">${esc(t('prog.title'))}</h2><a class="sec-link" href="#/goals">${esc(t('home.goals.all'))} <span class="ico ico-right" aria-hidden="true"></span></a></div>${body}</section>`;
}
const FOLD_TOP = 8;
/** Records: important work (open p0 cards, in your-turn order). */
function folderModel() {
  const open = ['todo', 'doing', 'review', 'blocked-on-user'];
  const important = S.data.tasks.filter((x) => x.priority === 'p0' && open.includes(x.status)).sort(byTurn).map((x) => x.id);
  return { important: { ids: important } };
}
function folderColumn() {
  const idx = progIndex();
  const f = folderModel();
  const fold = (key, label, ids, why) => {
    const head = `<span class="fold-name">${esc(label)}</span><span class="fold-n">${ids.length}</span>`;
    if (!ids.length) return `<div class="fold"><div class="fold-btn" data-zero>${head}</div></div>`;
    const open = S.folders.has(key);
    const mk = `fold-${key}`;
    const shown = S.more.has(mk) ? ids : ids.slice(0, FOLD_TOP);
    const more = ids.length > FOLD_TOP ? `<button type="button" class="more-link more-btn" data-action="more" data-key="${mk}" aria-expanded="${S.more.has(mk)}">${esc(S.more.has(mk) ? t('more.less') : t('fold.more', { n: ids.length - FOLD_TOP }))}</button>` : '';
    const list = open ? `<div class="fold-list" id="fold-${key}">${shown.map((id) => reportCard(idx.byId.get(id), reportLine(idx.byId.get(id), why))).join('')}${more}</div>` : '';
    return `<div class="fold"><button type="button" class="fold-btn" data-action="fold" data-key="${key}" aria-expanded="${open}" aria-controls="fold-${key}">${head}<span class="ico ico-right fold-caret" aria-hidden="true"></span></button>${list}</div>`;
  };
  return `<aside class="home-side${S.drawer ? ' open' : ''}" id="home-side"${S.drawer ? ` role="dialog" aria-modal="true" aria-label="${esc(t('fold.title'))}"` : ''}>
    <div class="side-head"><h2 class="side-title">${esc(t('fold.title'))}</h2><button type="button" class="ds-button side-close" data-variant="ghost" data-size="icon" data-action="drawer-close" aria-label="${esc(t('fold.close'))}">✕</button></div>
    ${fold('important', t('fold.important'), f.important.ids, 'important')}</aside>`;
}

function viewHome() {
  const live = S.data.tasks.filter((x) => x.status !== 'cancelled');
  const turn = turnOf(live);
  const running = live.filter((x) => x.status === 'doing').sort(runningOrder);
  const banner = turn.length
    ? `<div class="ds-banner sx-banner" data-tone="warning">
        <span class="sx-count">${turn.length}</span>
        <div class="ds-banner-body"><div class="ds-banner-title">${esc(t('home.turn'))}</div><div class="sx-split">${turnSplitHtml(turn)}</div><div class="sx-sub">${esc(t('home.turn.sub'))}</div>
          <a class="ds-button sx-answer" data-variant="primary" data-size="sm" href="#/today">${esc(t('home.answer'))} <span class="ico ico-right" aria-hidden="true"></span></a></div></div>`
    : `<div class="ds-banner" data-tone="success"><div class="ds-banner-body"><div class="ds-banner-title">${esc(t('home.turn.none'))}</div></div></div>`;
  // Order: what waits on the user (banner, then the list) and what runs now come first; the projects follow.
  // The records folder sits in a left column on wide screens and in a drawer behind the records button on a phone.
  const rec = `<button type="button" class="ds-button home-rec" data-variant="secondary" data-size="sm" data-action="drawer-open" aria-expanded="${S.drawer}" aria-controls="home-side">${esc(t('fold.title'))}</button>`;
  const scrim = S.drawer ? '<div class="home-scrim" data-action="drawer-close"></div>' : '';
  return `<div class="home-wrap">${folderColumn()}${scrim}<div class="home">${rec}${banner}
    <div class="home-row">
      <section><h2 class="sec-title">${esc(t('home.turn.first'))}</h2>${turnList(turn, 'home-turn', true)}</section>
      <section><h2 class="sec-title">${esc(t('home.running'))} <span class="n">${running.length}</span></h2><p class="turn-split">${esc(t('today.recent', { n: running.filter((x) => Date.now() - (Date.parse(x.updated) || 0) < STUCK_MS()).length, h: 6 }))}</p>${missionList(running, 'home-run', true)}</section>
    </div>
    ${progressSection()}</div></div>`;
}

// ---------- Goals ----------
const caret = (id, has) => `<button class="caret${has ? '' : ' spacer'}" data-action="toggle" data-id="${esc(id)}" aria-expanded="${S.expanded.has(id)}" aria-label="${esc(t('expand'))}">
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;

function viewGoals() {
  const ns = S.data.northstar || {};
  const r = S.data.rollup;
  const out = [`<div class="view-head"><h1>${esc(t('nav.goals'))}</h1></div><div class="goals-layout"><div>
    <div class="ns-card card row-like ${S.selected === 'north' ? 'selected' : ''}" data-action="select" data-id="north" style="cursor:pointer">
      <h2>${esc(tt(ns))}</h2>
      <p>${esc(ns.why)}</p>
      <p class="muted" style="font-size:13px">${esc(t('horizon', { h: ns.horizon || '' }))}</p>
      <div class="ns-pct"><b>${r.pct}%</b>${pctBar(r.pct)}</div>
    </div>${projectStrip()}<div class="tree">`];
  for (const g of D.goals()) {
    const gr = D.roll(g.id) || { pct: 0 };
    const open = S.expanded.has(g.id);
    out.push(`<div class="goal card">
      <div class="row goal-row ${S.selected === g.id ? 'selected' : ''}" data-action="select" data-id="${esc(g.id)}">
        ${caret(g.id, g.milestones.length)}<span class="title">${esc(tt(g))}</span>
        <span class="meta"><span class="chip owner">${esc(g.owner)}</span>${pctBar(gr.pct)}<span class="pct">${gr.pct}%</span></span>
      </div>`);
    if (open) for (const m of g.milestones) {
      const mr = D.roll(m.id) || { pct: 0, done: 0, total: 0 };
      const mall = S.data.tasks.filter((x) => x.milestone === m.id);
      const tasks = visibleTasks(mall);
      const mopen = S.expanded.has(m.id);
      out.push(`<div class="row ms-row ${S.selected === m.id ? 'selected' : ''}" data-action="select" data-id="${esc(m.id)}">
        ${caret(m.id, mall.length)}<span class="title">${esc(tt(m))}</span>
        <span class="meta">
          ${mr.late ? `<span class="chip late">${esc(t('late'))}</span>` : ''}
          ${m.due ? `<span class="chip">${esc(t('due', { d: m.due }))}</span>` : mr.needsDate ? `<span class="chip nodate">${esc(t('nodate'))}</span>` : ''}
          <span class="counts">${mr.done}/${mr.total}</span>${pctBar(mr.pct, mr.late)}<span class="pct">${mr.pct}%</span>
        </span></div>`);
      if (mopen) { for (const x of tasks) out.push(taskRow(x)); const note = archiveNote(mall); if (note) out.push(note); }
    }
    out.push('</div>');
  }
  out.push('</div></div></div>');
  return out.join('');
}

/** Computed server report only: stale describes the card's update time, never whether its job is alive. */
function stuckBadge(x) {
  const item = S.data?.stuck?.items.find((item) => item.id === x.id);
  if (!item) return '';
  // The card it waits on, by title when the board has it (an id only for a card it does not know).
  const name = (id) => { const c = D.task(id); return c ? tt(c) : id; };
  const detail = item.root_blocker ? ` · ${name(item.root_blocker)}` : item.missing?.length ? ` · ${item.missing.join(', ')}` : '';
  const ignored = item.missing_ignored?.length ? ` · ${t('stuck.ignored')}` : '';
  // Amber only when the card waits on the user; every other stall is a grey note.
  return `<span class="ds-badge stuck-badge${item.reason === 'blocked-user' && isTurn(x) ? ' turn-tag' : ''}" data-reason="${esc(item.reason)}" title="${esc(t(`stuck.${item.reason}`) + detail + ignored)}">${esc(item.reason !== 'blocked-user' ? t(`stuck.${item.reason}`) : isTurn(x) ? t(`turn.${turnKind(x)}`) : t('stuck.waits'))} · ${esc(ago(new Date(Date.now() - item.age_hours * 3600_000).toISOString()))}</span>${detail || ignored ? `<span class="stuck-detail">${esc((detail + ignored).replace(/^ · /, ''))}</span>` : ''}`; // the card it waits on: a tooltip on a pointer, a wrapping line on touch
}
function taskRow(x) {
  return `<div class="row task-row st-${esc(x.status)} ${S.selected === x.id ? 'selected' : ''}" data-action="select" data-id="${esc(x.id)}">
    <span class="dot st-${esc(x.status)}" title="${esc(stLabel(x.status))}"></span>
    <span class="title">${esc(tt(x))}</span>
    <span class="meta">
      ${x.status === 'blocked-on-user' ? `<span class="chip user">${esc(stLabel('blocked-on-user'))}</span>` : ''}
      ${x.lane !== 'none' ? `<span class="chip">${esc(enumLabel('lane', x.lane))}</span>` : ''}
      ${stuckBadge(x)}${claimChip(x)}<span class="chip owner">${esc(x.owner)}</span>${x.priority === 'p0' && x.status !== 'done' ? prioIcon(x.priority) : ''}
    </span></div>`;
}

// ---------- side panel ----------
// One panel for every node. ≥1024px it slides in over the right edge (no scrim; the board keeps its layout and stays
// clickable); below 1024px it is a full-height bottom sheet over a scrim (modal: focus stays in it). Only transform and
// opacity animate. A task opens in quick view; "Open card" turns the same panel into FULL mode (taskPanel).
// Live reloads redraw the content in place: no new animation, same scroll spot, same focus.
const SHEET_MQ = window.matchMedia('(max-width: 1023.98px)');
function openPanel(id) { if (S.selected !== id) S.panelMode = 'quick'; seenCard(id); S.selected = id; S.link = null; renderPanel(); }
/** Longest transition on `el` in ms (0 with reduced motion: the design-system durations are 0 there). */
function motionMs(el) {
  const cs = getComputedStyle(el);
  const list = (v) => String(v || '0s').split(',').map((d) => parseFloat(d) * (/ms\s*$/.test(d) ? 1 : 1000) || 0);
  const dur = list(cs.transitionDuration), del = list(cs.transitionDelay);
  return Math.max(0, ...dur.map((d, i) => d + (del[i] ?? del[0] ?? 0)));
}
/** Run `fn` once `el`'s own transform transition ends (or after its duration, if the browser never says). */
function afterMotion(el, fn) {
  const ms = motionMs(el);
  if (!ms) { fn(); return; }
  let timer = 0;
  const end = (e) => { if (e && (e.target !== el || e.propertyName !== 'transform')) return; el.removeEventListener('transitionend', end); clearTimeout(timer); fn(); };
  el.addEventListener('transitionend', end);
  timer = setTimeout(end, ms + 80);
}
function closePanel(clear = true) {
  if (clear) { S.selected = null; S.link = null; S.panelMode = 'quick'; }
  const p = $('#panel'), s = $('#scrim');
  if (p.hidden || !p.classList.contains('open')) { if (clear) returnFocus(); return; } // closed, or already on its way out
  p.classList.remove('open'); s.classList.remove('open'); document.body.classList.remove('panel-open');
  if (clear) returnFocus();
  afterMotion(p, () => { if (p.classList.contains('open')) return; p.hidden = true; s.hidden = true; p.innerHTML = ''; delete p.dataset.id; delete p.dataset.mode; });
}
/** Focus goes back to the card that opened the panel, found again by data-id (the board may have been redrawn meanwhile). */
function returnFocus() {
  const o = S.opener; S.opener = null;
  const a = document.activeElement;
  if (!o || (a && a !== document.body && !$('#panel').contains(a))) return; // the user already moved on
  const el = o.link !== undefined ? $(`#main [data-action="link"][data-i="${o.link}"]`)
    : $(`#main [data-action="select"][data-id="${CSS.escape(o.id)}"]`);
  if (!el) return;
  if (!el.matches('a[href],button,input,select,textarea,[tabindex]')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
}
const focusKey = (el) => el && `${el.dataset.action || ''}|${el.dataset.id || ''}|${el.dataset.lane || ''}|${el.getAttribute('href') || ''}|${el.name || ''}`;
/** Show `inner` in the panel. `key` + `mode` name what it shows: the same key and mode again = a live update, drawn in place. */
function showPanel(inner, key, mode = 'node') {
  const p = $('#panel'), s = $('#scrim');
  const open = !p.hidden && p.classList.contains('open');
  const same = open && p.dataset.id === key && p.dataset.mode === mode;
  const body = $('.qv-body', p);
  const keepScroll = same && body ? body.scrollTop : 0;
  const had = p.contains(document.activeElement) ? focusKey(document.activeElement) : null;
  p.innerHTML = `<div class="qv-grab" aria-hidden="true"></div><button type="button" class="ds-button close" data-variant="ghost" data-size="icon" data-action="close-panel" aria-label="${esc(t('close'))}">✕</button>${mode === 'node' ? `<div class="qv-bar"></div><div class="qv-body">${inner}</div>` : inner}`;
  p.dataset.id = key; p.dataset.mode = mode;
  if ($('#panel-title', p)) p.setAttribute('aria-labelledby', 'panel-title'); else p.removeAttribute('aria-labelledby');
  sheetMode();
  const nb = $('.qv-body', p); if (nb) nb.scrollTop = keepScroll;
  if (had) {
    // The focused control may be gone (e.g. a blocker link that opened another card): keep focus in the panel, never on body.
    const again = [...p.querySelectorAll('a,button,input,select,textarea')].find((el) => focusKey(el) === had);
    (again || $('[data-action="close-panel"]', p)).focus({ preventScroll: true });
  }
  if (open) return;
  p.hidden = false; s.hidden = false;
  p.getBoundingClientRect(); // start from the closed position, then let it slide in
  p.classList.add('open'); s.classList.add('open'); document.body.classList.add('panel-open');
  $('[data-action="close-panel"]', p).focus({ preventScroll: true });
}
/** Phone/tablet sheet = modal (scrim, focus trap); desktop side panel = not modal (the board stays usable). */
function sheetMode() { $('#panel').setAttribute('aria-modal', String(SHEET_MQ.matches)); }
SHEET_MQ.addEventListener?.('change', sheetMode);

function renderPanel() {
  const id = S.selected;
  const n = D.node(id);
  if (!n) { closePanel(); return; }
  const p = $('#panel');
  const mode = n.kind === 'task' ? (S.panelMode === 'full' ? 'full' : 'quick') : 'node';
  // Don't clobber a form the user is typing in, or has changed and not saved yet, when a live update arrives.
  if (!p.hidden && p.dataset.id === id && p.dataset.mode === mode && ((p.contains(document.activeElement) && document.activeElement.matches('input,textarea,select')) || [...p.querySelectorAll('form')].some(formDirty))) return;
  if (n.kind === 'task') {
    showPanel(mode === 'full' ? fullPanel(n.obj) : quickPanel(n.obj), id, mode); fillActivity(id, mode === 'quick' ? QV_ACTS : 0);
    return;
  }
  if (n.kind === 'milestone') return showPanel(milestonePanel(n.obj), id);
  if (n.kind === 'goal') return showPanel(goalPanel(n.obj), id);
  return showPanel(nsPanel(n.obj), id);
}

// ---------- quick view: the key facts first ----------
const QV_ACTS = 3; // latest activity entries in the quick view
/** Body sections that say what comes next, in this order of preference. */
const QV_NEXT = ['Next', 'Done criteria'];
/** The ask in the red box: only when the card is your turn (isTurn), from needs_user, else the Context "Do" line (the
 *  one turnRow shows). '' = no box. */
function qvAsk(x) {
  if (!isTurn(x)) return '';
  const c = ctxOf(x); const doRow = c && c.rows.find(([k]) => k === 'Do');
  return String(x.needs_user || '').trim() || (doRow ? String(doRow[1]).trim() : '');
}
/** Unfinished dependencies from depends_on ("a, b", "none", "x # note"): known open cards and unknown ids. */
function qvBlockers(x) {
  const raw = String(x.depends_on ?? '').replace(/#[\s\S]*$/, '');
  const ids = [...new Set(raw.split(/[,\s]+/).map((v) => v.trim()).filter((v) => v && v.toLowerCase() !== 'none'))];
  return ids.map((id) => ({ id, task: D.task(id) || null })).filter((b) => !b.task || (b.task.status !== 'done' && b.task.status !== 'cancelled'));
}
/** The first non-empty QV_NEXT section of the body: {heading, text}, else null. */
function qvNext(x) {
  for (const h of QV_NEXT) {
    const m = new RegExp(`(^|\\n)## ${h}[ \\t]*\\n([\\s\\S]*?)(?=\\n## |$)`).exec(x.body || '');
    const text = m ? m[2].trim() : '';
    if (text) return { heading: h, text };
  }
  return null;
}
/** Markdown-ish lines as text: "- x" lines become a list, the rest paragraphs (all escaped). */
function qvLines(text) {
  const out = []; let list = [];
  const flush = () => { if (list.length) out.push(`<ul>${list.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`); list = []; };
  for (const raw of String(text).split('\n')) {
    const l = raw.trim(); const b = /^[-*]\s+(.*)$/.exec(l);
    if (b) { list.push(b[1]); continue; }
    flush(); if (l) out.push(`<p>${esc(l)}</p>`);
  }
  flush();
  return out.join('');
}
/** PR line: "#20" (link) and where it stands, from the fields the card has (draft, your OK, in review, done). */
function qvPr(x) {
  const pr = safeUrl(x.pr); if (!pr) return '';
  const n = (/\/pull\/(\d+)/.exec(pr) || [])[1];
  const state = !hasOpenUserPr(x) ? ['draft', 'neutral'] : x.status === 'done' ? ['done', 'success'] : isTurn(x) ? ['yours', 'warning'] : x.status === 'review' ? ['review', 'info'] : null;
  return `<a class="qv-pr" href="${esc(pr)}" target="_blank" rel="noopener noreferrer">${n ? `#${esc(n)}` : esc(pr.replace(/^https?:\/\//, ''))}</a>${state ? ` <span class="ds-badge" data-tone="${state[1]}">${esc(t(`qv.pr.${state[0]}`))}</span>` : ''}`;
}
function qvFacts(x) {
  const rows = [
    ['status', `<span class="status st-${esc(x.status)}">${esc(stLabel(x.status))}</span> <span class="qv-dim">${esc(agoText(x.updated))}</span>`],
    ['owner', `${esc(x.owner)}${claimChip(x) ? ` ${claimChip(x)}` : ''}`],
    ['lane', esc(enumLabel('lane', x.lane))],
  ];
  // Shown once the card has a spec state, so a lifted block shows where it landed.
  if (x.spec_state && x.spec_state !== 'none') rows.push(['spec', esc(enumLabel('spec', x.spec_state))]);
  const pr = qvPr(x); if (pr) rows.push(['pr', pr]);
  if (x.secrets) rows.push(['secrets', `<code>${esc(x.secrets)}</code> <span class="qv-dim">${esc(t('secrets.hint'))}</span>`]);
  const bl = qvBlockers(x);
  if (bl.length) rows.push(['blockers', bl.map((b) => (b.task ? `<a href="#" class="qv-dep" data-action="select" data-id="${esc(b.id)}">${esc(tt(b.task))}</a> <span class="status st-${esc(b.task.status)}">${esc(stLabel(b.task.status))}</span>` : `<span class="mono">${esc(b.id)}</span>`)).join('<br>')]);
  return `<dl class="qv-facts" data-qv="facts">${rows.map(([k, v]) => `<div class="qv-row" data-field="${k}"><dt>${esc(t(`qv.f.${k}`))}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}
// ---------- Spec block on the card ----------
/** Card ids whose lift request is on its way: a live redraw meanwhile draws the button disabled, never re-enabled. */
const SB_INFLIGHT = new Set();
/** The card's Spec block: what was blocked, by whom, when, at which spec version; only a logged-in human gets the
 *  lift button (the server lets only actor user lift without a newer spec version). The button carries what this
 *  screen shows, its version included: the lift names that version, never one fetched at tap time. '' = not blocked. */
function specBlockHtml(x) {
  if (x.spec_state !== 'blocked') return '';
  const at = x.blocked_at ? `${stamp(x.blocked_at)} (${esc(agoText(x.blocked_at))})` : '';
  const rows = [['sb.note', esc(x.block_note || '')], ['sb.by', esc(x.blocked_by || '')], ['sb.at', at]].filter(([, v]) => v);
  const data = { id: x.id, version: x.version ?? 0, bv: x.blocked_spec_version ?? 0, note: x.block_note || '', by: x.blocked_by || '', at: x.blocked_at || '' };
  const attrs = Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  return `<section class="qv-sec sb" data-qv="specblock" role="note"${attrs}><h3>${esc(t('sb.title'))}</h3>
    <dl class="sb-facts">${rows.map(([k, v]) => `<dt>${esc(t(k))}</dt><dd>${v}</dd>`).join('')}</dl>
    <p class="sb-ver">${esc(t('sb.ver', { n: data.bv }))}</p>${AUTH.in ? sbButton(data) : ''}</section>`;
}
/** The lift button for a drawn block ({id, version}: the section's data); disabled while its lift is on its way. */
const sbButton = (d) => `<button type="button" class="ds-button sb-lift" data-variant="primary" data-action="spec-unblock" data-id="${esc(d.id)}" data-version="${esc(d.version)}"${SB_INFLIGHT.has(String(d.id)) ? ' disabled' : ''}>${esc(t('sb.lift'))}</button>`;
/** Login or logout: add or drop the lift button in every drawn Spec block, from the block as drawn (its version too). */
function syncSpecButtons() {
  for (const sec of document.querySelectorAll('#panel [data-qv="specblock"]')) {
    const btn = sec.querySelector('[data-action="spec-unblock"]');
    if (AUTH.in && !btn) sec.insertAdjacentHTML('beforeend', sbButton(sec.dataset));
    else if (!AUTH.in && btn) btn.remove();
  }
}
/** Tap on the lift button: read the current spec version (404 = 0), confirm what is lifted, then POST /spec/unblock as
 *  the logged-in user with the card version this screen drew. 200 = the board reloads; a refusal leaves the card as drawn. */
async function specUnblock(el) {
  const id = el.dataset.id;
  if (!id || SB_INFLIGHT.has(id)) return;
  const expected = Number(el.dataset.version); // the card as drawn, never re-read
  const d = el.closest('[data-qv="specblock"]')?.dataset || {};
  SB_INFLIGHT.add(id); el.disabled = true;
  let lifted = false;
  try {
    let sv = 0;
    try { sv = Number((await api(`/api/tasks/${encodeURIComponent(id)}/spec`)).metadata.version) || 0; }
    catch (e) { if (e.status !== 404) throw e; }
    if (!window.confirm(t('sb.confirm', { note: d.note, by: d.by, at: String(d.at || '').slice(0, 16).replace('T', ' '), bv: d.bv, cv: sv }))) return;
    await api(`/api/tasks/${encodeURIComponent(id)}/spec/unblock`, { expected_version: expected, expected_spec_version: sv });
    lifted = true;
  } catch (e) {
    toast(e.status === 409 ? t('sb.e409') : e.status === 403 ? t('sb.e403') : t('sb.efail', { n: e.status || 0 }), true);
  } finally {
    SB_INFLIGHT.delete(id);
    for (const b of document.querySelectorAll(`[data-action="spec-unblock"][data-id="${CSS.escape(id)}"]`)) b.disabled = false;
  }
  if (lifted) { toast(t('sb.done')); await load(); }
}
const ACTS = new Map(); // task id -> its last activity list (drawn at once on a redraw; the fetch then refreshes it)
/** What makes two notes "the same news": the first commit hash in the note (7+ hex, with a digit and a letter), else the
 *  text with its numbers blanked. Only notes fold; every status move stays its own line. */
const actKey = (a) => (a && a.action === 'note' && a.note
  ? ((/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/.exec(a.note) || [])[0] || String(a.note).replace(/\d+/g, '#').trim()) : null);
/** Pure: activity newest first -> groups; a run of notes with the same key becomes one group (newest first inside). */
function foldActs(acts) {
  const out = [];
  for (const a of acts || []) {
    const k = actKey(a); const last = out[out.length - 1];
    if (k && last && last.key === k) last.items.push(a); else out.push({ key: k, items: [a] });
  }
  return out;
}
const actWhen = (a) => esc(String(a.at || '').slice(5, 16).replace('T', ' '));
/** A status move as two pills (before → after). */
const actMove = (a) => (a.from || a.to ? ` <span class="act-move">${a.from ? `<span class="status st-${esc(a.from)}">${esc(stLabel(a.from))}</span>` : '·'} <span aria-hidden="true">→</span> ${a.to ? `<span class="status st-${esc(a.to)}">${esc(stLabel(a.to))}</span>` : '·'}</span>` : '');
const actLine = (a) => `<span class="when">${actWhen(a)}</span>
      <b>${esc(a.actor)}</b> ${esc(enumLabel('action', a.action))}${actMove(a)}${a.note ? `<div class="note">${esc(a.note)}</div>` : ''}`;
function actsHtml(acts, n) {
  const groups = foldActs(acts);
  const list = n ? groups.slice(0, n) : groups;
  return list.length ? `<ol class="acts">${list.map((g) => {
    if (g.items.length === 1) return `<li>${actLine(g.items[0])}</li>`;
    const newest = g.items[0], oldest = g.items[g.items.length - 1];
    return `<li class="act-fold"><details><summary><span class="when">${actWhen(oldest)}–${esc(String(newest.at || '').slice(11, 16))}</span> ${esc(t('act.fold', { n: g.items.length }))}<div class="note">${esc(newest.note)}</div></summary>
      <ol class="acts">${g.items.map((a) => `<li>${actLine(a)}</li>`).join('')}</ol></details></li>`;
  }).join('')}</ol>`
    : `<p class="empty">${esc(t('act.none'))}</p>`;
}
/** Quick view: chip line, title, red "needs your answer" box, context, facts, PR summary, next steps, latest activity;
 *  a pinned "Open card". */
function quickPanel(x) {
  const ask = qvAsk(x); const next = qvNext(x); const ctx = ctxHtml(x);
  const sec = (k, title, html) => `<section class="qv-sec" data-qv="${k}"><h3>${esc(title)}</h3>${html}</section>`;
  return `<div class="qv-bar" data-qv="head"><span class="chip app">${esc(appName(x.goal))}</span><span class="chip">${esc(x.priority)}</span><span class="chip">${esc(enumLabel('kind', x.kind))}</span></div>
  <div class="qv-body"><h2 id="panel-title">${esc(tt(x))}</h2>
    ${ask ? `<div class="qv-needs" data-qv="needs" role="note"><div class="qv-needs-k">${esc(t('qv.needs'))}</div><p>${esc(ask)}</p></div>` : ''}
    ${specBlockHtml(x)}
    ${ctx ? `<div class="qv-glance" data-qv="glance">${ctx}</div>` : ''}
    ${qvFacts(x)}
    ${x.pr_summary ? sec('prsum', t('kv.prsum'), `<p class="qv-text">${esc(x.pr_summary)}</p>`) : ''}
    ${next ? sec('next', t('qv.next'), `<div class="qv-text">${qvLines(next.text)}</div>`) : ''}
    ${sec('activity', t('qv.activity'), `<div class="activity" data-activity="${esc(x.id)}">${ACTS.has(x.id) ? actsHtml(ACTS.get(x.id), QV_ACTS) : `<p class="empty">${esc(t('loading'))}</p>`}</div>`)}
  </div>
  <div class="qv-foot" data-qv="foot"><button type="button" class="ds-button" data-variant="primary" data-action="qv-full" data-id="${esc(x.id)}">${esc(t('qv.open'))}</button><span class="mono qv-id">${esc(x.id)}</span></div>`;
}
/** FULL mode: the task panel with its edit form, and a way back to the quick view. */
function fullPanel(x) {
  return `<div class="qv-bar"><button type="button" class="ds-button" data-variant="ghost" data-size="sm" data-action="qv-back" data-id="${esc(x.id)}">‹ ${esc(t('qv.back'))}</button></div>
  <div class="qv-body">${taskPanel(x)}</div>`;
}

const field = (label, html) => `<label>${esc(label)}${html}</label>`;
/** A form remembers what it showed (data-base) and the version it was rendered from (data-version): a save sends only the
 *  fields the user changed, measured against that, never against data a live reload brought in meanwhile. */
const baseAttrs = (o, keys, version) => `data-base="${esc(JSON.stringify(Object.fromEntries(keys.map((k) => [k, k === 'done_criteria' ? (o[k] || []).join('\n') : String(o[k] ?? '')]))))}"${version !== undefined ? ` data-version="${esc(version)}"` : ''}`;
function formChanges(f) {
  let base = {}; try { base = JSON.parse(f.dataset.base || '{}'); } catch { /* none */ }
  const changed = {};
  const norm = (k, v) => (k === 'done_criteria' ? String(v).split('\n').map((x) => x.trim()).filter(Boolean).join('\n') : String(v));
  for (const [k, v] of new FormData(f)) if (Object.hasOwn(base, k) && norm(k, v) !== norm(k, base[k])) changed[k] = String(v);
  return { base, changed };
}
/** After a successful save the baseline becomes what was sent (normalized like the server stores it): anything typed
 *  while the request was on its way still differs from it, so it stays an unsaved edit. */
function rebase(f, sent, version) {
  let old = {}; try { old = JSON.parse(f.dataset.base || '{}'); } catch { /* none */ }
  const norm = (k, v) => (k === 'done_criteria' ? String(v).split('\n').map((x) => x.trim()).filter(Boolean).join('\n') : String(v));
  for (const [k, v] of Object.entries(sent)) if (Object.hasOwn(old, k)) old[k] = norm(k, v);
  f.dataset.base = JSON.stringify(old);
  if (version !== undefined) f.dataset.version = String(version);
}
const formDirty = (f) => (f.dataset.base ? Object.keys(formChanges(f).changed).length > 0 : [...f.querySelectorAll('textarea,input')].some((el) => el.value.trim()));
const saveBtn = () => `<div class="actions"><button class="ds-button" data-variant="primary" type="submit">${esc(t('save'))}</button></div>`;

function nsPanel(ns) {
  return `<div class="kind">${esc(t('northstar'))}</div><h2>${esc(tt(ns))}</h2>
  <form data-form="node" data-id="north" ${baseAttrs(ns, ['title', 'why', 'horizon'])}>
    ${field(t('f.title'), `<input class="ds-input" name="title" value="${esc(ns.title)}" required>`)}
    ${field(t('f.why'), `<textarea class="ds-input" name="why">${esc(ns.why)}</textarea>`)}
    ${field(t('f.horizon'), `<input class="ds-input" name="horizon" value="${esc(ns.horizon)}">`)}
    ${saveBtn()}
  </form>
  <section><h3>${esc(t('sec.goals'))}</h3>${D.goals().map((g) => { const gr = D.roll(g.id) || { pct: 0 }; return `<div class="row" data-action="select" data-id="${esc(g.id)}"><span class="title">${esc(appName(g.id))}</span>${pctBar(gr.pct)}<span class="pct">${gr.pct}%</span></div>`; }).join('')}
  <p class="muted" style="font-size:13px">${esc(t('rollup.note'))}</p></section>`;
}

function goalPanel(g) {
  const gr = D.roll(g.id) || { pct: 0 };
  return `<div class="kind">${esc(t('goal'))} · ${esc(appName(g.id))} · ${gr.pct}%</div><h2>${esc(tt(g))}</h2>
  <form data-form="node" data-id="${esc(g.id)}" ${baseAttrs(g, ['title', 'owner', 'why'])}>
    ${field(t('f.title'), `<input class="ds-input" name="title" value="${esc(g.title)}" required>`)}
    ${field(t('f.owner'), `<input class="ds-input" name="owner" value="${esc(g.owner)}">`)}
    ${field(t('f.why'), `<textarea class="ds-input" name="why">${esc(g.why)}</textarea>`)}
    ${saveBtn()}
  </form>
  <section><h3>${esc(t('sec.milestones'))}</h3>${g.milestones.map((m) => { const mr = D.roll(m.id) || { pct: 0 }; return `<div class="row" data-action="select" data-id="${esc(m.id)}"><span class="title">${esc(tt(m))}</span>${mr.late ? `<span class="chip late">${esc(t('late'))}</span>` : ''}${pctBar(mr.pct, mr.late)}<span class="pct">${mr.pct}%</span></div>`; }).join('')}</section>`;
}

function milestonePanel(m) {
  const mr = D.roll(m.id) || { pct: 0, done: 0, total: 0 };
  const tasks = S.data.tasks.filter((x) => x.milestone === m.id);
  return `<div class="kind">${esc(t('milestone'))} · ${esc(appName(appOf(m.id)))} · ${mr.done}/${mr.total} · ${mr.pct}%${mr.late ? ` · <span style="color:var(--late)">${esc(t('late'))}</span>` : ''}</div><h2>${esc(tt(m))}</h2>
  <form data-form="node" data-id="${esc(m.id)}" ${baseAttrs(m, ['title', 'status', 'due', 'done_criteria'])}>
    ${field(t('f.title'), `<input class="ds-input" name="title" value="${esc(m.title)}" required>`)}
    <div class="grid2">
      ${field(t('f.status'), `<select class="ds-select" name="status">${MS_STATUSES.map((s) => `<option value="${s}" ${s === m.status ? 'selected' : ''}>${esc(t(`ms.${s}`))}</option>`).join('')}</select>`)}
      ${field(t('f.due'), `<input class="ds-input" type="date" name="due" value="${esc(m.due)}">`)}
    </div>
    ${field(t('f.criteria'), `<textarea class="ds-input" name="done_criteria" rows="5">${esc(m.done_criteria.join('\n'))}</textarea>`)}
    ${saveBtn()}
  </form>
  <section><h3>${esc(t('sec.tasks'))}</h3>${tasks.length ? tasks.map(taskRow).join('') : `<p class="empty">${esc(t('notasks'))}</p>`}</section>`;
}

function taskPanel(x) {
  const pr = safeUrl(x.pr);
  const opt = (list, v, label) => list.map((s) => `<option value="${esc(s)}" ${s === v ? 'selected' : ''}>${esc(label ? label(s) : s)}</option>`).join('');
  const dt = (k, html) => `<dt>${esc(t(k))}</dt><dd>${html}</dd>`;
  return `<div class="kind">${esc(t('task'))} · ${esc(x.id)}</div><h2>${esc(tt(x))}</h2>
  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><span class="status st-${esc(x.status)}">${esc(stLabel(x.status))}</span>
    <span class="chip">${esc(enumLabel('kind', x.kind))}</span><span class="chip">${esc(x.priority)}</span>${x.approvals !== 'none' ? `<span class="chip">${esc(t('needs.approval', { a: enumLabel('appr', x.approvals) }))}</span>` : ''}</div>
  ${x.summary ? `<section class="handoff-summary"><h3>${esc(t('sec.summary'))}</h3><div class="summary-text">${esc(x.summary)}</div>${x.summary_by ? `<div class="muted">${esc(x.summary_by)}${x.summary_at ? ` · ${stamp(x.summary_at)} (${esc(agoText(x.summary_at))})` : ''}</div>` : ''}</section>` : ''}
  ${x.needs_user ? `<section><h3>${esc(t('sec.needs'))}</h3><div>${esc(x.needs_user)}</div></section>` : ''}
  ${specBlockHtml(x)}
  ${x.secrets ? `<section><h3>${esc(t('sec.secrets'))}</h3><div><code>${esc(x.secrets)}</code> <span class="muted">${esc(t('secrets.hint'))}</span></div></section>` : ''}
  ${ctxHtml(x) ? `<section><h3>${esc(t('sec.glance'))}</h3>${ctxHtml(x)}</section>` : ''}
  <form data-form="task" data-id="${esc(x.id)}" ${baseAttrs(x, ['title', 'status', 'owner', 'lane', 'priority', 'needs_user'], x.version ?? 0)}>
    ${field(t('f.title'), `<input class="ds-input" name="title" value="${esc(x.title)}" required>`)}
    <div class="grid2">
      ${field(t('f.status'), `<select class="ds-select" name="status">${opt([...STATUSES, 'cancelled'], x.status, stLabel)}</select>`)}
      ${field(t('f.owner'), `<input class="ds-input" name="owner" value="${esc(x.owner)}">`)}
    </div>
    <div class="grid2">
      ${field(t('f.lane'), `<select class="ds-select" name="lane">${opt(laneOptions(x.lane), x.lane, (l) => enumLabel('lane', l))}</select>`)}
      ${field(t('f.priority'), `<select class="ds-select" name="priority">${opt(['p0', 'p1', 'p2', 'p3'], x.priority)}</select>`)}
    </div>
    ${field(t('f.needs'), `<textarea class="ds-input" name="needs_user" rows="2">${esc(x.needs_user)}</textarea>`)}
    ${saveBtn()}
  </form>
  <dl class="kv">
    ${dt('kv.milestone', `<a href="#/goals" data-action="select" data-id="${esc(x.milestone)}">${esc(tt(D.milestone(x.milestone)) || x.milestone)}</a>`)}
    ${x.idea ? dt('kv.idea', `<span class="mono">${esc(x.idea)}</span>`) : ''}
    ${pr ? dt('kv.pr', `<a href="${esc(pr)}" target="_blank" rel="noopener noreferrer">${esc(pr.replace(/^https?:\/\//, ''))}</a>`) : ''}
    ${x.pr_summary ? dt('kv.prsum', esc(x.pr_summary)) : ''}
    ${x.result ? `<dt>${esc(t('kv.result'))}</dt><dd style="white-space:pre-wrap">${foldedText(x.result, `${x.id}|result`)}</dd>` : ''}
    ${x.claimed_by ? dt('kv.claimed', `${esc(x.claimed_by)} · ${stamp(x.claimed_at)} (${esc(agoText(x.claimed_at))})`) : ''}
    ${dt('kv.version', esc(x.version ?? 0))}
    ${dt('kv.startedby', `${esc(enumLabel('by', x.started_by))}${x.started_at ? ` · ${stamp(x.started_at)}` : ''}`)}
    ${dt('kv.updated', `${stamp(x.updated)} (${esc(agoText(x.updated))})`)}
    <dt>${esc(t('kv.file'))}</dt><dd class="mono">${esc(x.file)}</dd>
  </dl>
  <section><h3>${esc(t('sec.activity'))}</h3><div class="activity" data-activity="${esc(x.id)}"><p class="empty">${esc(t('loading'))}</p></div></section>
  <section><h3>${esc(t('sec.body'))}</h3>${cardLead(x) ? `<p class="lead">${esc(cardLead(x))}</p>` : ''}<pre class="body">${esc(foldLog(x.body).plain)}</pre>${rawToggle(x.body, `${x.id}|body`)}</section>
  <section><h3>${esc(t('sec.addnote'))}</h3><form data-form="note" data-id="${esc(x.id)}"><textarea class="ds-input" name="note" rows="2" placeholder="${esc(t('note.ph'))}"></textarea><div class="actions" style="margin-top:8px"><button class="ds-button" data-variant="secondary" type="submit">${esc(t('note.add'))}</button></div></form></section>`;
}

// ---------- activity log (GET /api/tasks/:id carries the last 50 entries) ----------
/** Fill the panel's activity list with the newest `n` entries (0 = all); the list is kept for the next redraw. */
async function fillActivity(id, n = 0) {
  const el = document.querySelector(`[data-activity="${CSS.escape(id)}"]`);
  if (!el) return;
  try {
    const x = await api(`/api/tasks/${encodeURIComponent(id)}`);
    const acts = (x.activity || []).slice().reverse();
    ACTS.set(id, acts);
    if (!el.isConnected) return;
    el.innerHTML = actsHtml(acts, n);
  } catch (e) { el.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}

// ---------- Context block: the "## Context" section of the task body, "Label: text" lines in any language ----------
function ctxOf(x) {
  const m = /(^|\n)## Context[ \t]*\n([\s\S]*?)(?=\n## |$)/.exec(x.body || '');
  if (!m) return null;
  const out = { rows: [] };
  for (const line of m[2].split('\n')) {
    const k = /^([^:]{1,10}):\s*(.*)$/.exec(line.trim());
    if (!k) { if (line.trim() && out.rows.length) out.rows[out.rows.length - 1][1] += ' ' + line.trim(); continue; }
    out.rows.push([k[1], k[2]]);
  }
  return out;
}
const ctxLabel = (k) => (Object.hasOwn(DICT.en, `ctx.${k}`) ? t(`ctx.${k}`) : k);
function ctxHtml(x) {
  const c = ctxOf(x);
  if (!c || !c.rows.length) return '';
  return `<dl class="ctx">${c.rows.map(([k, v]) => `<dt class="${k === 'Recommend' ? 'rec' : ''}">${esc(ctxLabel(k))}</dt><dd class="${k === 'Recommend' ? 'rec' : ''}">${esc(v)}</dd>`).join('')}</dl>`;
}

// ---------- Today ----------
// Today lists your turn in the same order as Home (turnOf: p0, then the longest wait).
function needsYou() { return turnOf(S.data.tasks); }
function byPrio(a, b) { return a.priority.localeCompare(b.priority) || b.updated.localeCompare(a.updated); }

/** A "show original" toggle with the whole original text, when foldLog hid any line of it ('' otherwise). Closed at first; `key`
 *  (card id | section) keeps it open across live redraws once opened (S.rawOpen, the toggle listener). */
const rawToggle = (text, key) => { const n = foldLog(text).hidden; return n > 0 ? `<details class="raw" data-raw="${esc(key)}"${S.rawOpen?.has(key) ? ' open' : ''}><summary>${esc(t('raw.show'))} · ${esc(t('raw.folded', { n }))}</summary><pre class="body">${esc(text)}</pre></details>` : ''; };
/** Text without its log lines, then the "show original" toggle (only the toggle when every line was a log line). */
const foldedText = (text, key) => `${esc(foldLog(text).plain)}${rawToggle(text, key)}`;
/** "… PR https://github.com/o/r/pull/12 …" reads as "… PR o/r#12 …" in one-line summaries. */
const shortPrs = (s) => String(s || '').replace(/https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\S*/g, '$1#$2');
/** A result line in people's words: "human (claude): PR owner/repo#86 …" reads "Claude · PR owner/repo#86 …" (the agent
 *  by name). */
const plainResult = (s) => shortPrs(s).replace(/^((?:human \((?:claude|codex)\):\s*)?)result:\s*/i, '$1').replace(/^human \((claude|codex)\):\s*/i, (_, a) => `${a[0].toUpperCase()}${a.slice(1).toLowerCase()} · `)
  // A result line reads as a sentence: no "result:" label (stripped above, also after the agent name), a machine path shows its last part ("…/x.md"), and a PR ref
  // said twice ("dasks#81 merged dasks#81") is said once.
  .replace(/\S+/g, shortPath).replace(/^(.*\S)\s+(\S+)\s*$/, (all, head, last) => (sameRefBefore(head, last) ? head : all));
/** One word of a result line: a machine path shows its last part ("…/x.md"); a URL (anything with "://") stays whole. */
const shortPath = (w) => (w.includes('://') ? w : w.replace(/(?<![^(['"`])(?:~|\/(?:Users|home|private|tmp|var|opt))\/[^)'"`,]+/g, (m) => `…/${m.split('/').filter(Boolean).pop()}`));
/** The line's last word is a PR ref the line already said, as a whole word (not dasks#810 vs dasks#81, not
 *  other/dasks#81 vs dasks#81). Word by word, so a long line costs one pass. */
const sameRefBefore = (head, last) => /^[\w.-]+#\d+$/.test(last) && head.split(/\s+/).some((w) => bare(w) === last);
/** A word without the brackets and quotes around it and the punctuation after it ("(dasks#81)," → "dasks#81"), in one pass from each end. */
function bare(w) {
  const open = '([{"\'`', close = ')]}"\'`.,;:'; // a leading dot belongs to the name (.github#81 is not github#81)
  let i = 0, j = w.length;
  while (i < j && open.includes(w[i])) i++;
  while (j > i && close.includes(w[j - 1])) j--;
  return w.slice(i, j);
}
function viewToday() {
  const needs = needsYou();
  const running = runningOf(S.data.tasks);
  const dayAgo = Date.now() - 24 * 3600_000;
  const finished = S.data.tasks.filter((x) => x.status === 'done' && Date.parse(x.updated) >= dayAgo).sort((a, b) => b.updated.localeCompare(a.updated));
  const noDate = [];
  for (const g of S.data.rollup.goals) for (const m of g.milestones) if (m.needsDate) noDate.push(m.id);
  const item = (x, sub) => `<div class="item card">
      <div class="top"><span class="chip app">${esc(appName(x.goal))}</span><span class="t" data-action="select" data-id="${esc(x.id)}" tabindex="0" role="button">${esc(tt(x))}</span></div>
      <div class="sub">${sub}</div></div>`;
  // Today leads with the work (your turn, running, finished); the per-project tiles (the same as Goals) come folded after it.
  return `<div class="view-head"><h1>${esc(t('today'))}</h1></div><div class="today">
  <section><h2><span class="dot st-blocked-on-user"></span>${esc(t('today.needs'))} <span class="n">${needs.length}</span></h2>
    ${needs.length ? `<p class="turn-split">${turnSplitHtml(needs)}</p>` : ''}
    ${answeredLines()}<div class="items">${needs.length ? needs.map(needItem).join('') : `<p class="empty">${esc(t('today.noneeds'))}</p>`}</div>
    ${noDate.length ? `<details class="needs-date"><summary class="more-link">${esc(t('today.nodate', { n: noDate.length }))}</summary><ul>${noDate.map((id) => { const m = D.milestone(id); return `<li data-action="select" data-id="${esc(id)}"><span class="chip app">${esc(appName(appOf(id)))}</span>${esc(tt(m))}</li>`; }).join('')}</ul></details>` : ''}
  </section>
  <section class="compact"><h2><span class="dot st-doing"></span>${esc(t('today.running'))} <span class="n">${running.length}</span></h2>
    <p class="turn-split">${esc(t('today.recent', { n: running.filter((x) => Date.now() - (Date.parse(x.updated) || 0) < STUCK_MS()).length, h: 6 }))}</p>
    ${missionList([...running].sort(runningOrder), 'today-run', true, 8)}
  </section>
  <section class="compact"><h2><span class="dot st-done"></span>${esc(t('today.finished'))} <span class="n">${finished.length}</span></h2>
    <div class="items">${finished.length ? limited(finished, 'today-fin', 8).map((x) => item(x, esc(plainResult(resultLine(x)) || cardLead(x) || '—'))).join('') : `<p class="empty">${esc(t('today.nofin'))}</p>`}</div>${moreBtn('today-fin', finished.length - 8)}
  </section></div>
  <details class="today-proj"${S.todayProjOpen ? ' open' : ''}><summary class="more-link">${esc(t('today.byproj'))}</summary>${projectStrip()}</details>`;
}

/** One your-turn card read as a decision: the question first (needs_user, else the Context "Do" line), the Recommend
 *  line right above the buttons, the rest of the Context folded. A Context block whose rows all say the same thing is
 *  shown once, with a flag asking for a rewrite. */
function needParts(x) {
  const c = ctxOf(x);
  const rows = c ? c.rows : [];
  const row = (k) => { const r = rows.find(([key]) => key === k); return r ? String(r[1]).trim() : ''; };
  const same = rows.length >= 3 && new Set(rows.map(([, v]) => String(v).trim())).size === 1;
  const ask = turnAsk(x) || (x.status === 'review' ? t('review.ready') : '');
  return { ask, rec: same ? '' : row('Recommend'), same, more: rows.length > 0 && !same };
}
/** A card with an open user ask (A/B choice) is answered on /asks, not marked done here. */
function needItem(x) {
  const pr = safeUrl(x.pr);
  const p = needParts(x);
  const commenting = S.commenting === x.id;
  const btn = (action, key, primary) => `<button type="button" class="ds-button" data-variant="${primary ? 'primary' : 'secondary'}" data-action="${action}" data-id="${esc(x.id)}">${esc(t(key))}</button>`;
  const prsum = x.pr_summary && x.status === 'review' && ctxOf(x);
  const more = p.more || prsum ? `<details class="need-more" data-need="${esc(x.id)}"${S.needOpen?.has(x.id) ? ' open' : ''}><summary class="more-link">${esc(t('need.more'))}</summary>
      ${p.more ? ctxHtml(x) : ''}${prsum ? `<p class="need-prsum"><b>${esc(t('kv.prsum'))}</b> ${esc(x.pr_summary)}</p>` : ''}</details>` : '';
  return `<div class="item card need" data-id="${esc(x.id)}">
    <div class="top"><span class="chip app">${esc(appName(x.goal))}</span><span class="turn-tag">${esc(t(`turn.${turnKind(x)}`))}</span>${x.priority === 'p0' ? prioIcon(x.priority) : ''}<span class="need-age">${esc(ago(x.updated))}</span></div>
    <div class="t" data-action="select" data-id="${esc(x.id)}" tabindex="0" role="button">${esc(tt(x))}</div>
    ${p.ask ? `<p class="need-q">${esc(p.ask)}</p>` : ''}
    ${p.same ? `<p class="need-dup"><span class="ds-badge" data-tone="warning">${esc(t('need.same'))}</span></p>` : ''}
    ${p.rec ? `<p class="need-rec"><span class="ds-badge" data-tone="accent">${esc(t('ctx.Recommend'))}</span><span>${esc(p.rec)}</span></p>` : ''}
    ${pr ? `<a class="sub" href="${esc(pr)}" target="_blank" rel="noopener noreferrer">${esc(pr.replace(/^https?:\/\//, ''))}</a>` : ''}
    ${commenting ? `<form data-form="comment" data-id="${esc(x.id)}"><textarea class="ds-input" name="note" placeholder="${esc(t('comment.ph'))}" required></textarea>
      <div class="btns"><button class="ds-button" data-variant="primary" type="submit">${esc(t('btn.send'))}</button><button class="ds-button" data-variant="secondary" type="button" data-action="cancel-comment">${esc(t('btn.cancel'))}</button></div></form>`
    : `<div class="btns">${x.user_ask ? `<a class="ds-button" data-variant="primary" href="/asks#${encodeURIComponent(x.id)}">${esc(t('btn.decide'))}</a>` : x.status === 'review' ? btn('approve', 'btn.approve', true) : btn('done', `btn.done.${turnKind(x)}`, true)}${x.lane === 'failed-terminal' ? btn('reset', 'btn.reset') : ''}${btn('comment', 'btn.comment')}</div>`}
    ${more}
  </div>`;
}
/** Answers given on this page in the last 10 minutes, newest first: the green "done" lines over the list. */
const ANSWER_MS = 10 * 60_000;
function answeredLines() {
  const now = Date.now();
  S.answered = (S.answered || []).filter((a) => now - a.at < ANSWER_MS);
  if (!S.answered.length) return '';
  return `<ul class="answered" role="status">${S.answered.slice(0, 3).map((a) => `<li><span aria-hidden="true">✓</span> ${esc(t(a.key, { title: a.title }))}</li>`).join('')}</ul>`;
}
function noteAnswered(id, key) {
  const x = D.task(id);
  S.answered = [{ id, key, title: x ? tt(x) : id, at: Date.now() }, ...(S.answered || []).filter((a) => a.id !== id)];
}

/** Running cards older than this are flagged as possibly stalled. */
const STUCK_MS = () => 6 * 3600_000;
const PRIO_RANK = { p0: 0, p1: 1, p2: 2, p3: 3 };

// ---------- Archive (old done, cancelled) ----------
const ARCHIVE_MS = 7 * 86400000;
/** Archived = cancelled, or done more than 7 days ago (by its last update). Hidden unless the toggle is on. */
function isArchived(x) {
  if (x.status === 'cancelled') return true;
  return x.status === 'done' && Date.now() - Date.parse(x.updated) > ARCHIVE_MS;
}
function visibleTasks(tasks) { return S.archive ? tasks : tasks.filter((x) => !isArchived(x)); }
/** One line with the count and the toggle; empty when nothing in `tasks` is archived. */
function archiveNote(tasks) {
  const n = tasks.filter(isArchived).length;
  if (!n) return '';
  return `<p class="archive-note"><button type="button" class="more-link" data-action="archive" aria-pressed="${S.archive}">${esc(t(S.archive ? 'archive.shown' : 'archive.hidden', { n }))}</button></p>`;
}
function toggleArchive() { S.archive = !S.archive; store('dasks.archive', S.archive ? '1' : '0'); render(); }
function pageTasks(app) { return visibleTasks(S.data.tasks.filter((x) => x.goal === app)); }

// ---------- Board ----------
/** The cards of the board scope: every card for 'all', else one goal or one milestone. */
function scopeAll() {
  const sc = S.scope;
  const tasks = S.data.tasks;
  if (D.goal(sc)) return tasks.filter((x) => x.goal === sc);
  if (D.milestone(sc)) return tasks.filter((x) => x.milestone === sc);
  return tasks;
}
const isOpenCard = (x) => x.status !== 'done' && x.status !== 'cancelled' && !isArchived(x);
/** Board column order: most urgent first, then the card waiting longest (created, else updated). byPrio stays
 *  newest-first for the other views. */
const ageMs = (x) => Date.parse(x.created || x.updated) || 0;
const boardOrder = (a, b) => String(a.priority || 'p3').localeCompare(String(b.priority || 'p3')) || ageMs(a) - ageMs(b) || a.id.localeCompare(b.id);
const BOARD_CAP = 6;
function viewBoard() {
  if (S.scope !== 'all' && !D.goal(S.scope) && !D.milestone(S.scope)) S.scope = 'all';
  // The goal a scope belongs to: its chip is pressed and its milestones fill the select.
  const goal = D.goal(S.scope) || D.goals().find((g) => g.milestones.some((m) => m.id === S.scope)) || null;
  const pickedId = goal ? goal.id : 'all';
  // Chip counts are open cards over the whole board, never narrowed by the search or the stuck filter.
  const openIn = (id) => S.data.tasks.filter((x) => (id === 'all' || x.goal === id) && isOpenCard(x)).length;
  const chipList = [['all', t('board.scope.all')], ...D.goals().map((g) => [g.id, appName(g.id)])]
    .map(([id, label]) => [id, label, openIn(id)]).filter(([id, , n]) => id === 'all' || n || id === pickedId);
  const chips = `<div class="board-chips" role="group" aria-label="${esc(t('board.pick'))}">${chipList.map(([id, label, n]) => `<button type="button" class="chip board-chip" data-action="scope-chip" data-scope="${esc(id)}" aria-pressed="${id === pickedId}">${esc(label)} <span class="n">${n}</span></button>`).join('')}</div>`;
  const picker = goal ? `<select class="ds-select picker" data-action="scope" aria-label="${esc(t('board.pick'))}">
    <option value="${esc(goal.id)}" ${S.scope === goal.id ? 'selected' : ''}>${esc(t('board.all', { a: appName(goal.id) }))}</option>
    ${goal.milestones.map((m) => `<option value="${esc(m.id)}" ${S.scope === m.id ? 'selected' : ''}>${esc(tt(m))}</option>`).join('')}</select>` : '';
  const mode = `<div class="ds-segmented" role="group" aria-label="${esc(t('board.layout'))}"><button type="button" class="ds-segment" data-action="mode" data-mode="board" aria-pressed="${S.mode === 'board'}">${esc(t('board.board'))}</button><button type="button" class="ds-segment" data-action="mode" data-mode="list" aria-pressed="${S.mode === 'list'}">${esc(t('board.list'))}</button></div>`;
  // A search looks through every project (title, card id, owner), not just the picked scope.
  const q = S.q.trim().toLowerCase();
  const hit = (x) => [tt(x), x.title, x.id, x.owner].some((v) => String(v || '').toLowerCase().includes(q));
  const all = q ? S.data.tasks : scopeAll();
  const tasks = visibleTasks(all).filter((x) => !q || hit(x));
  const stuckIds = new Set((S.data.stuck?.items || []).map((item) => item.id));
  const nStuck = tasks.filter((x) => stuckIds.has(x.id)).length;
  const shown = S.boardStuck ? tasks.filter((x) => stuckIds.has(x.id)) : tasks;
  const open = shown.filter((x) => x.status !== 'done');
  // Done cards live behind the "done today" pill: "today" means the card's last update falls on today's local calendar
  // day (done_at is sent only for the done ticker's window).
  const done = tasks.filter((x) => x.status === 'done').sort((a, b) => (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0));
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const nToday = done.filter((x) => { const ms = Date.parse(x.updated); return ms >= dayStart && ms < dayEnd; }).length;
  const doneOpen = S.boardDone || (q && done.length > 0); // a search with done hits shows them
  const pills = `<div class="board-pills"><button type="button" class="board-pill" data-action="board-done" data-drop="done" aria-pressed="${!!S.boardDone}">${esc(t('board.done.today', { n: nToday }))}</button>${S.data.stuck
    ? `<button type="button" class="board-pill" data-action="board-stuck" aria-pressed="${!!S.boardStuck}" title="${esc(t('stuck.note'))}"${!nStuck && !S.boardStuck ? ' disabled' : ''}>${esc(t('board.stuck', { n: nStuck }))}</button>` : ''}</div>`;
  const doneList = doneOpen ? `<section class="done-list" aria-label="${esc(stLabel('done'))}">${done.length
    ? done.map((x) => `<div class="done-row" data-action="select" data-id="${esc(x.id)}" tabindex="0" role="button"><span class="title">${esc(tt(x))}</span><span class="when">${esc(ago(x.updated))}</span></div>`).join('')
    : `<p class="empty">${esc(t('board.empty'))}</p>`}</section>` : '';
  const search = `<input type="search" class="ds-input board-q" data-action="board-q" value="${esc(S.q)}" placeholder="${esc(t('board.q'))}" aria-label="${esc(t('board.q'))}" enterkeyhint="search">`;
  let body;
  // Your turn (blocked on the user) leads both layouts: the first column on the board, the first group in the list. Done has
  // no column: it is the pill and its list.
  const COLS = ['blocked-on-user', ...STATUSES.filter((s) => s !== 'blocked-on-user' && s !== 'done')];
  if (!tasks.length) body = `<p class="empty" style="padding:14px">${esc(t('board.empty'))}</p>`;
  else if (S.mode === 'list') {
    // Grouped by status in column order, so each row needs no status of its own; a row's one meta line is its wait.
    // A row opens its card and nothing else: marking done happens in the side panel.
    const row = (x) => `<div class="check st-${esc(x.status)}" data-action="select" data-id="${esc(x.id)}"><span class="title">${esc(tt(x))}</span>${stuckBadge(x)}</div>`;
    // Statuses with no board column (cancelled, shown with the archive) follow the columns, so no card drops out.
    // The first group is your turn by the shared rule (isTurn: blocked on the user, or a PR waiting for the user's OK),
    // the same number Home and the goal tiles show; every other card sits under its status.
    const listed = [...open].sort(byPrio); // the list keeps the order other views use (urgent first, then newest)
    const order = [...COLS, ...new Set(listed.map((x) => x.status).filter((st) => !COLS.includes(st)))];
    const groups = [['blocked-on-user', listed.filter(isTurn)], ...order.filter((st) => st !== 'blocked-on-user')
      .map((st) => [st, listed.filter((x) => x.status === st && !isTurn(x))]), ['blocked-on-user', listed.filter((x) => x.status === 'blocked-on-user' && !isTurn(x))]]
      .filter(([, g]) => g.length);
    body = `<div class="checklist card">${groups.map(([st, g]) => `<h3 class="check-group"><span class="dot st-${esc(st)}"></span>${esc(stLabel(st))} <span class="n">${g.length}</span></h3>${g.map(row).join('')}`).join('')}</div>`;
  } else {
    // Your-turn column = the shared rule (isTurn), like the list and Home; a review PR waiting for the user's OK sits there,
    // not under Review. An empty column folds to a strip that still takes a drop; a full one shows its first six until
    // expanded, and a search shows every hit.
    const colOf = (st) => (st === 'blocked-on-user' ? open.filter(isTurn) : open.filter((x) => x.status === st && !isTurn(x))).sort(boardOrder);
    body = `<div class="kanban">${COLS.map((s) => {
      const col = colOf(s);
      const head = `<h3><span class="dot st-${s}"></span><span class="col-name">${esc(stLabel(s))}</span> <span class="n">${col.length}</span></h3>`;
      if (!col.length) return `<div class="col folded" data-drop="${s}" title="${esc(stLabel(s))}">${head}</div>`;
      const key = `board:${s}`; const over = !q && col.length > BOARD_CAP; const expanded = S.more.has(key);
      const more = over ? `<button type="button" class="more-link" data-action="more" data-key="${key}" aria-expanded="${expanded}">${esc(expanded ? t('board.less') : t('board.more', { n: col.length - BOARD_CAP }))}</button>` : '';
      return `<div class="col" data-drop="${s}">${head}<div class="cards">${(over && !expanded ? col.slice(0, BOARD_CAP) : col).map(kcard).join('')}</div>${more}</div>`;
    }).join('')}</div>`;
  }
  const found = q ? `<p class="tri-cache">${esc(t('board.found', { n: tasks.length }))}</p>` : '';
  return `<div class="view-head"><h1>${esc(t('board'))}</h1>${search}${picker}${pills}${mode}</div>${chips}${found || archiveNote(all)}${doneList}${body}`;
}
/** One board card: the title, then one meta row (decision, priority, age, then what it waits on or its lane). A stuck card
 *  gets a warning edge. */
function kcard(x) {
  const stuck = !!S.data.stuck?.items.some((item) => item.id === x.id);
  const decision = x.kind === 'decision' || x.user_ask ? `<span class="chip decision-tag">${esc(t('board.decision'))}</span>` : '';
  const wait = stuck ? stuckBadge(x) : x.lane && x.lane !== 'none' ? `<span class="chip">${esc(enumLabel('lane', x.lane))}</span>` : '';
  const born = x.created || x.updated;
  return `<div class="kcard card"${stuck ? ' data-stuck' : ''} draggable="true" data-drag="${esc(x.id)}">
    <div class="t" data-action="select" data-id="${esc(x.id)}" tabindex="0" role="button" style="cursor:pointer">${esc(tt(x))}</div>
    <div class="tags">${decision}${prioIcon(x.priority)}<span class="chip age" title="${stamp(born)}">${esc(ago(born))}</span>${wait}</div>
    <select class="ds-select kmove" data-size="sm" data-action="set-status" data-id="${esc(x.id)}" aria-label="${esc(t('board.moveto'))}">${STATUSES.map((s) => `<option value="${s}" ${s === x.status ? 'selected' : ''}>${esc(stLabel(s))}</option>`).join('')}</select>
  </div>`;
}

// ---------- Connections ----------
function nodePos() {
  const ids = D.goals().map((g) => g.id);
  const pos = {}; const cx = 400, cy = 270, r = 205;
  ids.forEach((id, i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / ids.length; pos[id] = [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
  pos.north = [cx, cy];
  return { ids, pos };
}

/** A two-word project name (Mobile App, Help Center) goes on two lines so it stays inside its ring. */
const nodeText = (name) => (name.includes(' ') ? `<text class="two" y="-10">${name.split(' ').map((w, i) => `<tspan x="0" dy="${i ? 14 : 0}">${esc(w)}</tspan>`).join('')}</text>` : `<text y="-2">${esc(name)}</text>`);
function viewConnections() {
  const links = S.data.links;
  const { ids, pos } = nodePos();
  // One arrow per project pair and link type (a count when several cards link the same way), so the map stays readable.
  const groups = new Map();
  links.forEach((l, i) => {
    const a = appOf(l.from), b = appOf(l.to);
    if (a === b || !pos[a] || !pos[b]) return;
    const k = `${a}|${b}|${l.type}`;
    if (!groups.has(k)) groups.set(k, { a, b, type: l.type, items: [] });
    groups.get(k).items.push(i);
  });
  const pairs = {};
  for (const [k, g] of groups) { const p = [g.a, g.b].sort().join('|'); (pairs[p] = pairs[p] || []).push(k); }
  const edges = [];
  for (const [key, g] of groups) {
    const { a, b } = g, i = g.items[0], l = links[i];
    const group = pairs[[a, b].sort().join('|')];
    const k = group.indexOf(key) - (group.length - 1) / 2;
    const [x1, y1] = pos[a], [x2, y2] = pos[b];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const sgn = a < b ? 1 : -1;
    const off = group.length > 1 ? (k * 26 + 10) * sgn : 0;
    const r = 44, ux = dx / len, uy = dy / len;
    const sx = x1 + ux * r, sy = y1 + uy * r, ex = x2 - ux * (r + 6), ey = y2 - uy * (r + 6);
    const qx = (x1 + x2) / 2 + nx * off * 2, qy = (y1 + y2) / 2 + ny * off * 2;
    const d = `M${sx.toFixed(1)},${sy.toFixed(1)} Q${qx.toFixed(1)},${qy.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`;
    const sel = g.items.includes(S.link);
    const tip = g.items.map((j) => `${links[j].from} → ${links[j].to}: ${links[j].note}`).join('\n');
    const n = g.items.length;
    // the count sits a third of the way along the curve, clear of the hub and of the target's label
    const at = (p, q, e) => 0.4225 * p + 0.455 * q + 0.1225 * e; // quadratic Bézier at t = 0.35
    const badge = n > 1 ? `<g class="ecount" transform="translate(${at(sx, qx, ex).toFixed(1)},${at(sy, qy, ey).toFixed(1)})"><circle r="10"/><text y="4">${n}</text></g>` : '';
    edges.push(`<g><path class="hit" d="${d}" data-action="link" data-i="${i}"><title>${esc(tip)}</title></path><path class="edge ${esc(l.type)} ${sel ? 'sel' : ''}" d="${d}" marker-end="url(#arr-${esc(l.type)})"/>${badge}</g>`);
  }
  const nodeR = ids.length > 6 ? 38 : 44;
  const nodes = ids.map((id) => {
    const [x, y] = pos[id];
    const g = D.roll(id); const pct = g ? g.pct : 0;
    const C = 2 * Math.PI * nodeR;
    return `<g class="node" data-action="select-app" data-id="${esc(id)}" style="cursor:pointer" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
      <circle r="${nodeR}"/><circle class="ring" r="${nodeR}" stroke-dasharray="${(C * pct / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90)"/>
      ${nodeText(appName(id))}<text class="sub" y="${appName(id).includes(' ') ? 24 : 16}">${pct}%</text></g>`;
  }).join('');
  const spokes = ids.map((id) => `<line class="spoke" x1="400" y1="270" x2="${pos[id][0].toFixed(1)}" y2="${pos[id][1].toFixed(1)}"/>`).join('');
  const marker = (k) => `<marker id="arr-${k}" viewBox="0 0 10 10" refX="8" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--${k})"/></marker>`;
  const svg = `<svg viewBox="80 20 640 500" role="img" aria-label="${esc(t('conn.map'))}"><defs>${['feeds', 'blocks', 'shares'].map(marker).join('')}</defs>
    ${spokes}${edges.join('')}<g class="center"><circle cx="400" cy="270" r="34"/><text x="400" y="275">${esc(PROPER.north)}</text></g>${nodes}</svg>`;
  const list = links.map((l, i) => linkCard(l, i)).join('');
  return `<div class="view-head"><h1>${esc(t('conn'))}</h1><div class="legend">${['feeds', 'blocks', 'shares'].map((k) => `<span><i style="background:var(--${k})"></i>${esc(t(`link.${k}`))}</span>`).join('')}</div></div>
  <div class="conn"><div class="map card">${svg}</div><div class="links-list">${list || `<p class="empty">${esc(t('conn.empty'))}</p>`}</div></div>`;
}

function nodeLabel(id) {
  const n = D.node(id);
  return `<span class="chip app">${esc(appName(appOf(id)))}</span><span>${esc(n ? n.title : id)}</span>`;
}
function linkCard(l, i) {
  return `<div class="link card ${esc(l.type)} ${S.link === i ? 'sel' : ''}" data-action="link" data-i="${i}">
    <div class="ends">${nodeLabel(l.from)}<span class="arrow">→ ${esc(t(`link.${l.type}`))} →</span>${nodeLabel(l.to)}</div>
    <div class="muted">${esc(l.note)}</div></div>`;
}
function renderLinkPanel() {
  const l = S.data.links[S.link];
  if (!l) { closePanel(); return; }
  const end = (id, key) => { const n = D.node(id); return `<section><h3>${esc(t(key))}</h3>
    <div class="row" data-action="goto" data-id="${esc(id)}"><span class="title">${esc(n ? n.title : id)}</span><span class="chip">${esc(n ? t(n.kind) : t('unknown'))}</span></div>
    <div class="mono muted" style="padding:0 14px">${esc(id)}</div></section>`; };
  showPanel(`<div class="kind">${esc(t('link'))} · ${esc(t(`link.${l.type}`))}</div><h2>${esc(l.note || `${l.from} → ${l.to}`)}</h2>${end(l.from, 'sec.from')}${end(l.to, 'sec.to')}
    <p class="muted" style="font-size:13px">${esc(t('conn.edit'))}</p>`, `link-${S.link}`);
}

// ---------- writes ----------
/** Every write from this page names the version the user was looking at: if the card changed meanwhile (a new PR, a
 *  status move), the server answers 409 and nothing lands. Then say so and show the fresh card. */
async function writeTask(id, body, okMsg) {
  const x = D.task(id);
  const guarded = { ...body, ...(x ? { expected_version: x.version ?? 0 } : {}) };
  try {
    // A card that asks the user (review, blocked-on-user) moves on only with a signed decision.
    // A card waiting on a user decision (user_ask) is answered in /asks; a hand move needs no approve/reject receipt.
    if (x && !x.user_ask && body.status && body.status !== x.status && ASKING.includes(x.status)) await decideFirst(x, body.status === 'done' ? 'approve' : 'reject');
    await api(`/api/tasks/${encodeURIComponent(id)}`, guarded);
  // A refused move (state rule) says why; only a version conflict means someone else changed the card.
  } catch (e) { toast(e.status === 409 && e.rule !== 'transition' ? t('toast.changed') : e.message, true); await load(); return false; }
  toast(okMsg);
  // The write landed: a failed refresh after it must not hide that (the next live event or tick reloads).
  try { await load(); } catch (e) { toast(e.message, true); }
  return true;
}
const ASKING = ['review', 'blocked-on-user'];
/** Record the decision for exactly the question this screen shows (the card's decision_request from the last board
 *  load, never one fetched now): if the card asks something else by now, the server answers 409 and nothing is signed.
 *  An earlier identical answer counts. */
async function decideFirst(x, choice) {
  const want = x.decision_request;
  if (!want || want.card !== x.id || want.revision !== (x.version ?? 0)) throw Object.assign(new Error(t('toast.changed')), { status: 409 });
  try { await api('/api/decisions', { card: want.card, revision: want.revision, scope: want.scope, choice }); }
  catch (e) { if (!(e.status === 409 && e.data && e.data.decision && e.data.decision.choice === choice && e.data.decision.scope_hash === want.scope_hash)) throw e; }
}
async function setStatus(id, status) {
  const x = D.task(id);
  if (!x || x.status === status) return;
  const body = { status };
  // Moving a done card back to todo/doing, or a cancelled card anywhere, is a reopen; the server refuses it without the flag.
  if (x.status === 'cancelled' || (x.status === 'done' && ['todo', 'doing'].includes(status))) body.reopen = true;
  if (status === 'blocked-on-user' && !x.needs_user) {
    const need = window.prompt(t('prompt.need'));
    if (!need) { render(); return; }
    body.needs_user = need;
  }
  await writeTask(id, body, t('toast.moved', { s: stLabel(status) }));
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action],[data-lang]');
  if (!el) return;
  if (el.dataset.lang) { setLang(el.dataset.lang); return; }
  const a = el.dataset.action, id = el.dataset.id;
  if (a === 'auth') { el.disabled = true; try { await authClick(); } finally { el.disabled = false; } return; }
  if (a === 'toggle') {
    e.stopPropagation();
    S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id);
    store('dasks.expanded', JSON.stringify([...S.expanded]));
    render();
  } else if (a === 'tick-more') {
    TICK.open = !TICK.open; renderDoneTicker(); $('#done-ticker [data-action="tick-more"]')?.focus({ preventScroll: true });
  } else if (a === 'tick-ok') {
    tickSeen();
  } else if (a === 'sum-more') {
    SUM.open = !SUM.open; renderSummary(); $('#day-summary [data-action="sum-more"]')?.focus({ preventScroll: true });
  } else if (a === 'sum-ok') {
    SUM.seen = S.summary?.at || ''; store(SUM_KEY, SUM.seen); SUM.open = false; renderSummary();
  } else if (a === 'select') {
    if (el.matches('input')) return;
    e.preventDefault();
    if (S.drawer && el.closest('#home-side')) S.drawer = false; // a card picked in the records drawer: the drawer goes first
    // Focus goes back here on close; a card picked inside the panel (a blocker, a milestone's task) keeps the first one.
    if (!el.closest('#panel')) S.opener = { id };
    openPanel(id); if (S.view === 'goals' || S.view === 'home') render();
  } else if (a === 'spec-unblock') {
    await specUnblock(el);
  } else if (a === 'qv-full' || a === 'qv-back') {
    // Leaving full mode redraws the panel: unsaved edits there are only dropped after the user says so.
    if (a === 'qv-back' && [...$('#panel').querySelectorAll('form')].some(formDirty) && !window.confirm(t('confirm.discard'))) return;
    S.panelMode = a === 'qv-full' ? 'full' : 'quick'; renderPanel();
    $(`#panel [data-action="${a === 'qv-full' ? 'qv-back' : 'qv-full'}"]`)?.focus({ preventScroll: true });
  } else if (a === 'goto') {
    S.selected = id; S.link = null; S.keepSelection = true; S.expanded.add(appOf(id));
    const x = D.task(id); if (x) S.expanded.add(x.milestone);
    location.hash = '#/goals';
  } else if (a === 'select-app') {
    S.selected = id; S.keepSelection = true; S.expanded.add(id); location.hash = '#/goals';
  } else if (a === 'close-panel') closePanel();
  else if (a === 'done') {
    el.disabled = true;
    // A green line says it went through (the reload drops the card from the list).
    if (await writeTask(id, { status: 'done', if_status: 'review,blocked-on-user', note: t('note.fromToday') }, t('toast.done'))) { noteAnswered(id, 'need.answered.done'); render(); }
  } else if (a === 'approve') {
    el.disabled = true;
    const x = D.task(id);
    // The approval names what was approved: the version and the PR the user saw (only while it is still in review).
    const pr = x && safeUrl(x.pr);
    if (await writeTask(id, { status: 'done', if_status: 'review', note: `${t('note.approved')}${x && x.approvals !== 'none' ? ` (${enumLabel('appr', x.approvals)})` : ''}${pr ? ` ${pr}` : ''} v${x ? x.version ?? 0 : 0}` }, t('toast.approved'))) { noteAnswered(id, 'need.answered.approve'); render(); }
  } else if (a === 'reset') {
    // Retry cap reached: the user resets the attempt count with a one-line reason (the server requires one).
    const reason = window.prompt(t('prompt.reset'));
    if (!reason || !reason.trim()) return;
    el.disabled = true;
    const x = D.task(id);
    try { await api(`/api/tasks/${encodeURIComponent(id)}/reset-attempts`, { reason: reason.trim(), ...(x ? { expected_version: x.version ?? 0 } : {}) }); toast(t('toast.reset')); }
    catch (e) { toast(e.message, true); }
    await load();
  } else if (a === 'comment') { S.commenting = id; render(); const ta = document.querySelector('form[data-form="comment"] textarea'); ta && ta.focus(); }
  else if (a === 'cancel-comment') { S.commenting = null; render(); }
  else if (a === 'mode') { S.mode = el.dataset.mode; store('dasks.mode', S.mode); render(); }
  else if (a === 'archive') toggleArchive();
  else if (a === 'more') { const k = el.dataset.key; S.more.has(k) ? S.more.delete(k) : S.more.add(k); render(); }
  else if (a === 'prog') {
    const same = S.prog?.app === id && S.prog.kind === el.dataset.key;
    S.prog = same ? null : { app: id, kind: el.dataset.key };
    render(); refocus(`[data-action="prog"][data-id="${CSS.escape(id)}"][data-key="${CSS.escape(el.dataset.key)}"]`);
  } else if (a === 'fold') {
    const k = el.dataset.key; S.folders.has(k) ? S.folders.delete(k) : S.folders.add(k);
    render(); refocus(`[data-action="fold"][data-key="${CSS.escape(k)}"]`);
  } else if (a === 'drawer-open') { S.drawer = true; render(); refocus('#home-side [data-action="drawer-close"]'); }
  else if (a === 'drawer-close') closeDrawer();
  else if (a === 'scope-chip') { S.scope = el.dataset.scope; store('dasks.scope', S.scope); render(); }
  else if (a === 'board-done') { S.boardDone = !S.boardDone; render(); }
  else if (a === 'board-stuck') { S.boardStuck = !S.boardStuck; render(); }
  else if (a === 'link') { S.link = Number(el.dataset.i); S.selected = null; if (!el.closest('#panel')) S.opener = { link: S.link }; render(); }
});

// Stuck flags depend on the clock, not only on board changes: while the board or goals page is on screen, reload the
// board once a minute (the normal load path: counts and chips redraw together). One reload at a time; nothing while the
// tab is hidden or another view is open.
async function boardTick() {
  if (PAGE || !['board', 'goals'].includes(S.view) || document.hidden || boardTick.busy || loadsInFlight > 0) return false;
  boardTick.busy = true;
  try { await load(); } catch { /* the next tick or a live event retries */ } finally { boardTick.busy = false; }
  return true;
}
setInterval(boardTick, 60_000);
// Folded <details> sections remember open/closed across live re-renders (toggle does not bubble: listen in capture).
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement)) return;
  // Today: a card's folded context stays open across live reloads.
  if (d.classList.contains('need-more')) { S.needOpen ??= new Set(); d.open ? S.needOpen.add(d.dataset.need) : S.needOpen.delete(d.dataset.need); return; }
  if (d.classList.contains('today-proj')) { S.todayProjOpen = d.open; return; }
  // Card panel: an opened "show original" stays open across live redraws of the same card.
  if (d.classList.contains('raw') && d.dataset.raw) { S.rawOpen ??= new Set(); d.open ? S.rawOpen.add(d.dataset.raw) : S.rawOpen.delete(d.dataset.raw); return; }
}, true);
// Board search: re-render on each keystroke, but never mid-composition (a Korean syllable being typed would be lost).
document.addEventListener('input', (e) => {
  if (e.target.dataset?.action === 'board-q' && !e.isComposing) { S.q = e.target.value; render(); }
});
document.addEventListener('compositionstart', (e) => { if (e.target.dataset?.action === 'board-q') S.composing = true; });
document.addEventListener('compositionend', (e) => {
  if (e.target.dataset?.action === 'board-q') { S.composing = false; S.q = e.target.value; render(); }
});
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.action === 'scope') { S.scope = el.value; store('dasks.scope', S.scope); render(); }
  else if (el.dataset.action === 'set-status') await setStatus(el.dataset.id, el.value);
});
document.addEventListener('submit', async (e) => {
  const f = e.target; e.preventDefault();
  const fd = new FormData(f); const id = f.dataset.id;
  const btn = f.querySelector('[type=submit]'); if (btn) btn.disabled = true;
  try {
    if (f.dataset.form === 'task') {
      const { changed: body } = formChanges(f);
      if (!Object.keys(body).length) { toast(t('nochange')); return; }
      const sent = { ...body };
      body.expected_version = Number(f.dataset.version || 0);
      // Same rule as the board: done -> todo/doing and cancelled -> anything is a reopen.
      const cur = D.task(id);
      if (cur && body.status && body.status !== cur.status && (cur.status === 'cancelled' || (cur.status === 'done' && ['todo', 'doing'].includes(body.status)))) body.reopen = true;
      let saved;
      try { saved = await api(`/api/tasks/${encodeURIComponent(id)}`, body); }
      catch (err) {
        if (err.status === 409 && err.rule === 'transition') { toast(err.message, true); return; } // refused move: keep the form, say why
        if (err.status === 409 && err.data?.decision_request) { toast(err.message, true); return; } // a decision this form must not sign: keep the form, say why
        if (err.status === 409) { toast(t('toast.changed'), true); $('#panel').innerHTML = ''; await load(); return; }
        throw err;
      }
      rebase(f, sent, saved.version);
      toast(t('saved')); document.activeElement?.blur(); await load();
    } else if (f.dataset.form === 'node') {
      // Only what changed, with what it was: the server refuses (409) if an agent changed one of these fields meanwhile.
      const { base, changed } = formChanges(f);
      if (!Object.keys(changed).length) { toast(t('nochange')); return; }
      const body = { expected: {} };
      for (const [k, v] of Object.entries(changed)) { body[k] = k === 'done_criteria' ? v.split('\n').map((x) => x.trim()).filter(Boolean) : v; body.expected[k] = base[k]; }
      try { await api(`/api/nodes/${encodeURIComponent(id)}`, body); }
      catch (err) { if (err.status === 409) { toast(t('toast.changed'), true); $('#panel').innerHTML = ''; await load(); return; } throw err; }
      rebase(f, changed);
      toast(t('saved')); document.activeElement?.blur(); await load();
    } else if (f.dataset.form === 'note' || f.dataset.form === 'comment') {
      const note = String(fd.get('note') || '').trim(); if (!note) return;
      await api(`/api/tasks/${encodeURIComponent(id)}`, { note }); S.commenting = null;
      // Sent: the field is empty again, so the panel no longer counts as "being edited" and can refresh.
      for (const el of f.querySelectorAll('textarea')) if (el.value.trim() === note) el.value = '';
      toast(t('toast.comment')); document.activeElement?.blur(); await load();
    }
  } catch (err) { toast(err.message, true); } finally { if (btn) btn.disabled = false; }
});

// drag & drop (desktop); touch uses the per-card status select
document.addEventListener('dragstart', (e) => { const c = e.target.closest?.('[data-drag]'); if (!c) return; e.dataTransfer.setData('text/plain', c.dataset.drag); c.classList.add('dragging'); });
document.addEventListener('dragend', (e) => { e.target.classList?.remove('dragging'); document.querySelectorAll('[data-drop].drop').forEach((c) => c.classList.remove('drop')); });
document.addEventListener('dragover', (e) => { const col = e.target.closest?.('[data-drop]'); if (!col) return; e.preventDefault(); col.classList.add('drop'); });
document.addEventListener('dragleave', (e) => { const col = e.target.closest?.('[data-drop]'); if (col && !col.contains(e.relatedTarget)) col.classList.remove('drop'); });
document.addEventListener('drop', async (e) => {
  const col = e.target.closest?.('[data-drop]'); if (!col) return;
  e.preventDefault(); col.classList.remove('drop');
  // A card dropped on the column it is already shown in does nothing: a review PR waiting for the user's OK sits under
  // your turn (isTurn) while its status stays review, so a drop there must not write blocked-on-user (a reject).
  const id = e.dataTransfer.getData('text/plain'), x = D.task(id);
  if (x && (isTurn(x) ? 'blocked-on-user' : x.status) === col.dataset.drop) return;
  await setStatus(id, col.dataset.drop);
});
/** Focus a control again after render() drew it anew (the old node is gone). */
const refocus = (sel) => $(`#main ${sel}`)?.focus({ preventScroll: true });
function closeDrawer() { S.drawer = false; render(); refocus('[data-action="drawer-open"]'); }
document.addEventListener('keydown', (e) => {
  const p = $('#panel'); const open = !p.hidden && p.classList.contains('open');
  if (e.key === 'Escape' && open) { closePanel(); return; }
  // Home: Esc closes the records drawer, then the open count list (the card panel above goes first).
  if (e.key === 'Escape' && S.view === 'home' && S.drawer) { closeDrawer(); return; }
  if (e.key === 'Escape' && S.view === 'home' && S.prog) {
    const { app, kind } = S.prog; S.prog = null; render();
    refocus(`[data-action="prog"][data-id="${CSS.escape(app)}"][data-key="${CSS.escape(kind)}"]`); return;
  }
  // The sheet (below 1024px) is modal: Tab cycles inside it.
  if (e.key === 'Tab' && open && SHEET_MQ.matches) {
    const f = [...p.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && (i < 0 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
    return;
  }
  // Cards that are not buttons (role="button") open with Enter or Space too.
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[role="button"][data-action="select"]')) {
    e.preventDefault(); e.target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
});
$('#scrim').addEventListener('click', () => closePanel());

// live reload via SSE
let seen = null; // {boot, version} of the last event
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', (e) => {
    $('#live').classList.add('on');
    // Reconnected (board restart, laptop sleep): reload if anything may have changed while we were away.
    let d = {}; try { d = JSON.parse(e.data); } catch { /* no payload */ }
    // First connection: compare with the board this page loaded (a write may have landed in between).
    const was = seen || (S.data ? { boot: d.boot, version: S.data.version } : null);
    if (!was || d.boot !== was.boot || d.version !== was.version) reloadSoon();
    seen = d;
  });
  es.addEventListener('change', (e) => { try { seen = JSON.parse(e.data); } catch { /* no payload */ } reloadSoon(); });
  es.onerror = () => {
    $('#live').classList.remove('on');
    // The browser retries on its own, except after an error answer (e.g. 503): then open a new stream ourselves.
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 10_000);
  };
}

// ---------- Project pages (/p/<app>) ----------
const ST_ORDER = { 'blocked-on-user': 0, review: 1, doing: 2, todo: 3, done: 4, cancelled: 5 };
const appTasks = (app) => S.data.tasks.filter((x) => x.status !== 'cancelled' && x.goal === app);
// Your turn per project (goal tiles, project pages): the same rule as everywhere else (isTurn), not every review card.
const needsOf = (tasks) => turnOf(tasks);
const runningOf = (tasks) => tasks.filter((x) => x.status === 'doing').sort((a, b) => (a.started_at || a.updated).localeCompare(b.started_at || b.updated));
const matches = (x, words) => words.some((w) => `${x.id} ${x.title} ${x.title_ko || ''} ${x.title_en || ''}`.toLowerCase().includes(String(w).toLowerCase()));
const byOpen = (a, b) => ST_ORDER[a.status] - ST_ORDER[b.status] || byPrio(a, b);
/** A widget's or node's text in the current language: <k>_<lang>, else <k>. */
const loc = (o, k) => (o && (o[`${k}_${LANG}`] || o[k])) || '';

/** The projects, drawn as the same goal cards as Home (one goal card design everywhere: Home, Goals, Today's fold). */
function projectStrip() {
  return `<nav class="goal-grid pstrip-grid" aria-label="${esc(t('nav.projects'))}">${projects().map(goalCard).join('')}</nav>`;
}
function projectCard(app) {
  const g = D.goal(app); if (!g) return '';
  const tasks = appTasks(app);
  const need = needsOf(tasks).length, run = runningOf(tasks).length, pct = Math.round(D.roll(app)?.pct ?? 0);
  return `<a class="pcard card" href="/p/${esc(app)}">
    <span class="pname">${esc(appName(app))}</span>
    <span class="pbig">${pct}<small>%</small></span>
    ${pctBar(pct)}
    <span class="pmeta">${need ? `<span class="ds-badge" data-tone="warning">${esc(t('p.needyou', { n: need }))}</span>` : `<span class="ds-badge" data-variant="outline">${esc(t('p.clear'))}</span>`}${run ? `<span class="ds-badge">${esc(t('p.running', { n: run }))}</span>` : ''}</span>
  </a>`;
}

function projectChrome() {
  document.body.classList.add('project-mode');
  const list = projects();
  const links = list.map((a) => `<a href="/p/${esc(a)}" data-p="${esc(a)}" ${a === PAGE ? 'aria-current="page"' : ''}>${esc(appName(a))}</a>`).join('');
  // The More buttons stay (login and language live in that menu); only the links become project links.
  const [moreTop, moreBottom] = [$('.tabs .nav-more'), $('.bottombar .nav-more')];
  $('.tabs').innerHTML = `<a href="/">${esc(t('nav.board'))}</a>${links}`;
  if (moreTop) $('.tabs').append(moreTop);
  $('.tabs').setAttribute('aria-label', t('nav.projects'));
  $('.bottombar').innerHTML = `<a href="/"><span>${esc(t('nav.back'))}</span></a>${list.map((a) => `<a href="/p/${esc(a)}" ${a === PAGE ? 'aria-current="page"' : ''}><span>${esc(appName(a))}</span></a>`).join('')}`;
  if (moreBottom) $('.bottombar').append(moreBottom);
  // On /p/<app> a hash link would stay on the project page: the menu's board views go to the board.
  for (const a of document.querySelectorAll('#more-menu a[href^="#/"]')) a.setAttribute('href', `/${a.getAttribute('href')}`);
  $('.bottombar').setAttribute('aria-label', t('nav.projects'));
  $('.brand').setAttribute('href', '/');
}

function projectWidgets(v, g) {
  // Every project shows its tasks in its structure and its ideas; a view without those widgets gets them at the end.
  const widgets = [...v.widgets];
  // A project with a profile shows it near the top (after the stat cards) unless the view places it.
  if (g?.profile && !widgets.some((w) => w.type === 'profile')) { const at = widgets.findIndex((w) => w.type !== 'stats'); widgets.splice(at < 0 ? widgets.length : at, 0, { type: 'profile' }); }
  if (!widgets.some((w) => w.type === 'work')) widgets.push({ type: 'work' });
  if (!widgets.some((w) => w.type === 'ideas')) widgets.push({ type: 'ideas' });
  // The dependency graph sits right after the tasks unless the view places it; an auto one hides when nothing links.
  if (!widgets.some((w) => w.type === 'deps')) widgets.splice(widgets.findIndex((w) => w.type === 'work') + 1, 0, { type: 'deps', auto: true });
  return widgets;
}

function widgetSection(w, g, v, i) {
  let html = '';
  try { html = (Object.hasOwn(WIDGET, w.type) ? WIDGET[w.type] : () => '')(w, g, v, i); } catch (e) { console.error(e); html = `<p class="empty">${esc(t('w.failed', { w: w.type }))}</p>`; }
  if (!html) return '';
  // Agent-written titles are text (escaped); only the built-in HEAD headings are markup.
  const title = loc(w, 'title') ? esc(loc(w, 'title')) : Object.hasOwn(HEAD, w.type) ? HEAD[w.type](v) : '';
  const extra = w.type === 'work' ? ` structure-${esc(v.structure || 'list')}` : '';
  return `<section class="pw pw-${esc(w.type)}${extra} ${w.span === 'half' ? 'half' : 'full'}" data-i="${i}">${title ? `<h2>${title}</h2>` : ''}${html}</section>`;
}

function viewProject() {
  projectChrome();
  const g = D.goal(PAGE);
  if (!g) return `<p class="empty">${esc(t('noproject', { p: PAGE }))} <a href="/">${esc(t('backtoboard'))}</a></p>`;
  const v = S.pview || { widgets: [] };
  const name = loc(v, 'title') || appName(PAGE);
  document.title = `${name} · Dasks`;
  const goalLine = loc(v, 'tagline') || tagOf(g) || tt(g);
  const body = projectWidgets(v, g).map((w, i) => widgetSection(w, g, v, i)).join('');
  const who = v.default ? t('p.layout.default') : t('p.layout', { v: v.version, who: v.updated_by, t: ago(v.updated) });
  const repo = g.repo && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(g.repo) ? g.repo.replace(/\/$/, '') : '';
  const repoLine = repo ? `<p class="prepo"><a href="${esc(repo)}" target="_blank" rel="noopener noreferrer">${esc(repo.replace('https://github.com/', ''))}</a></p>` : '';
  return `<div class="phead"><h1>${esc(name)}</h1><p class="pgoal"><b>${esc(t('p.goal'))}</b> ${esc(goalLine)}</p>${repoLine}</div>
    ${nowStrip(appTasks(PAGE), g)}
    <div class="pgrid">${body}</div>
    <p class="pfoot">${esc(who)} · ${esc(t('p.edit', { cmd: `dasks view set ${PAGE}` }))}</p>`;
}

// ---------- project page: the Now strip and "new since you last looked" ----------
// Drawn from board data only (no server writes). The last-seen time lives in this browser's localStorage, one key per
// project page; without storage the marks still work for this tab (the time the page was last hidden).
const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const NOW_WHY = { blocked: 0, overdue: 1, today: 2 };
const NOW_TONE = { blocked: 'danger', overdue: 'warning', today: 'info' };
const NOW_TOP = 6;
/** Open cards that wait on the user, or whose milestone is past due / due today (local day): [{x, why, due}]. */
function nowItems(tasks, g, today = dayOf(new Date())) {
  const due = new Map((g.milestones || []).filter((m) => m.due && m.status !== 'done').map((m) => [m.id, m.due]));
  const out = [];
  for (const x of tasks) {
    if (x.status === 'done' || x.status === 'cancelled') continue;
    const d = due.get(x.milestone) || '';
    const why = x.status === 'blocked-on-user' ? 'blocked' : d && d < today ? 'overdue' : d === today ? 'today' : '';
    if (why) out.push({ x, why, due: d });
  }
  return out.sort((a, b) => NOW_WHY[a.why] - NOW_WHY[b.why] || a.due.localeCompare(b.due) || byPrio(a.x, b.x));
}
function nowStrip(tasks, g) {
  const items = nowItems(tasks, g);
  const fresh = tasks.filter(isNewSince).length;
  const head = `<h2>${esc(t('now'))}${items.length ? ` <span class="hmeta">${items.length}</span>` : ''}${fresh ? ` <span class="hmeta now-fresh">${esc(t('new.count', { n: fresh }))}</span>` : ''}</h2>`;
  if (!items.length) return `<section class="pnow quiet" aria-label="${esc(t('now'))}">${head}<p class="empty">${esc(t('now.clear'))}</p></section>`;
  const rows = limited(items, 'now', NOW_TOP).map(({ x, why, due }) => `<li class="nowrow st-${esc(x.status)}">
    <span class="ds-badge" data-tone="${NOW_TONE[why]}">${esc(t(`now.${why}`))}</span>
    <button type="button" class="ptitle pick" data-action="select" data-id="${esc(x.id)}">${esc(tt(x))}</button>${newMark(x)}
    <span class="nowmeta">${esc(due && why !== 'blocked' ? due.slice(5) : ago(x.updated))}</span></li>`).join('');
  return `<section class="pnow" aria-label="${esc(t('now'))}">${head}<ul class="nowlist">${rows}</ul>${moreBtn('now', items.length - NOW_TOP)}</section>`;
}

const SEEN_KEY = PAGE ? `dasks.seen.${PAGE}` : '';
/** since: the viewer's last look at this page (ms; 0 = first visit, nothing is marked); opened: card id -> its
 *  `updated` (ms) when the viewer opened it, so a later write marks it again. */
const SEEN = { since: (SEEN_KEY && Number(stored(SEEN_KEY))) || 0, hiddenAt: 0, opened: new Map() };
// A first visit sets the baseline now, so the next visit has one even if this tab never fires pagehide.
if (SEEN_KEY && !SEEN.since) store(SEEN_KEY, String(Date.now()));
/** The card's status, PR or log moved after the viewer last looked (every progress write bumps `updated`). */
const isNewSince = (x) => { const u = Date.parse(x.updated) || 0; return SEEN.since > 0 && u > SEEN.since && u > (SEEN.opened.get(x.id) ?? 0); };
const newMark = (x) => (PAGE && isNewSince(x) ? `<span class="newmark" data-new="${esc(x.id)}" title="${esc(t('new.title', { t: ago(x.updated) }))}">${esc(t('new'))}</span>` : '');
/** Opening a card counts as looking at it: its mark goes away now, not on the next redraw. */
function seenCard(id) {
  if (!PAGE || !id) return;
  const x = S.data && D.task(id);
  SEEN.opened.set(id, x ? Date.parse(x.updated) || 0 : Infinity);
  for (const el of document.querySelectorAll(`.newmark[data-new="${CSS.escape(id)}"]`)) el.remove();
}
function leavePage() { if (!SEEN_KEY) return; SEEN.hiddenAt = Date.now(); store(SEEN_KEY, String(SEEN.hiddenAt)); }
if (SEEN_KEY) {
  window.addEventListener('pagehide', leavePage);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { leavePage(); return; }
    // Back on the page: what moved while it was hidden is the new "new".
    if (SEEN.hiddenAt) { SEEN.since = SEEN.hiddenAt; SEEN.opened.clear(); render(); }
  });
}

// Default headings for widgets that always appear (escaped HTML).
const HEAD = {
  work: (v) => `${esc(t('work'))} <span class="hmeta">${esc(t(`work.${v.structure || 'list'}`))}</span>`,
  ideas: () => { const open = (S.ideas?.ideas || []).filter((i) => i.status === 'open').length; return `${esc(t('ideas'))}${open ? ` <span class="hmeta">${open}</span>` : ''}`; },
  deps: () => esc(t('deps')),
  profile: () => esc(t('profile')),
};

function rowTask(x, sub) {
  const pr = safeUrl(x.pr);
  return `<li class="prow st-${esc(x.status)}"><span class="dot st-${esc(x.status)}" title="${esc(stLabel(x.status))}"></span>
    <span class="pt"><button type="button" class="ptitle pick" data-action="select" data-id="${esc(x.id)}">${esc(tt(x))}</button>${newMark(x)}${sub ? `<span class="psub">${sub}</span>` : ''}</span>
    ${pr ? `<a class="ppr" href="${esc(pr)}" target="_blank" rel="noopener noreferrer">${esc(t('kv.pr'))}</a>` : ''}</li>`;
}
const listOrEmpty = (items, emptyKey) => (items.length ? `<ul class="plist">${items.join('')}</ul>` : `<p class="empty">${esc(t(emptyKey))}</p>`);
const more = (n) => (n > 0 ? `<p class="pmore">${esc(t('w.more', { n }))}</p>` : '');
const msState = (m, r) => (r.pct >= 100 || m.status === 'done' ? 'done' : m.status === 'blocked' || r.late ? 'blocked' : m.status === 'active' ? 'active' : 'planned');
const statusSub = (x) => `<b class="st-${esc(x.status)}">${esc(stLabel(x.status))}</b> · ${esc(ago(x.updated))}`;

/** Last notes of a task (## Notes lines "- YYYY-MM-DD HH:MM actor: text"), newest first. */
function notesOf(x, n = 2) {
  const m = /(^|\n)## Notes\n([\s\S]*?)(?=\n## |$)/.exec(x.body || '');
  if (!m) return [];
  return m[2].split('\n').map((l) => /^-\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+([^:]{1,40}):\s*(.*)$/.exec(l.trim())).filter(Boolean)
    .map((r) => ({ at: r[1].replace(' ', 'T'), who: r[2], text: r[3] })).slice(-n).reverse();
}

const workOpenTasks = (tasks) => tasks.filter((x) => x.status !== 'done').sort(byOpen);
const statusTaskRows = (tasks, lim) => tasks.slice(0, lim).map((x) => rowTask(x, statusSub(x)));

function workColumn(tasks, status, weekAgo) {
  const col = tasks.filter((x) => x.status === status);
  if (status === 'done') return col.filter((x) => Date.parse(x.updated) >= weekAgo).sort((a, b) => b.updated.localeCompare(a.updated));
  if (status === 'blocked-on-user' || status === 'review') return col.sort(byTurn);
  if (status === 'doing') return col.sort(runningOrder);
  return col.sort(byPrio);
}

function workCard(x, status) {
  const stale = isStale(x);
  const meta = status === 'doing' ? (isRunnerCard(x) ? esc(t('runner.running')) : stale ? `<span class="stalled">${esc(t('stalled'))}</span>` : esc(t('doing.for', { t: doingFor(x) }))) : esc(ago(x.updated));
  return `<div class="ds-kanban-card${stale ? ' stale' : ''}" data-action="select" data-id="${esc(x.id)}" tabindex="0" role="button"><span class="kc-title">${x.status === 'done' ? '' : `${prioIcon(x.priority)} `}${esc(tt(x))}${newMark(x)}</span><span class="ds-kanban-meta">${claimChip(x)}${meta}</span></div>`;
}

const WORK = {
  kanban(tasks, lim) {
    const weekAgo = Date.now() - 7 * 86400000;
    const cols = ['blocked-on-user', 'review', 'doing', 'todo', 'done'];
    return `<div class="ds-kanban pkanban">${cols.map((s) => {
      const col = workColumn(tasks, s, weekAgo);
      const total = s === 'done' ? tasks.filter((x) => x.status === 'done').length : col.length;
      return `<div class="ds-kanban-col st-${s}"${s === 'blocked-on-user' && col.length ? ' data-active' : ''}><div class="ds-kanban-head"><span class="dot st-${s}"></span>${esc(stLabel(s))} · ${total}${s === 'done' ? ` <span class="hmeta">${esc(t('work.recentdone'))}</span>` : ''}</div>
        ${col.slice(0, lim).map((x) => workCard(x, s)).join('')}${more(col.length - lim)}</div>`;
    }).join('')}</div>`;
  },
  threads(tasks, lim) {
    // Open cards, plus what finished in the last two days: the live conversations.
    const recent = Date.now() - 2 * 86400000;
    const live = tasks.filter((x) => x.status !== 'done' || Date.parse(x.updated) >= recent).sort((a, b) => b.updated.localeCompare(a.updated));
    return live.length ? `<ol class="threads">${live.slice(0, lim).map((x) => {
      // Notes that are log lines drop out; then the card's lead, its Context "Do" row, its result line (logs folded).
      const notes = notesOf(x, Infinity).filter((n) => !isLogLine(n.text)).slice(0, 2);
      const c = ctxOf(x); const doRow = c && c.rows.find(([k]) => k === 'Do');
      const lead = cardLead(x); const res = plainResult(resultLine(x));
      const lines = notes.length ? notes.map((n) => `<li><b>${esc(n.who)}</b> <span class="when">${esc(ago(n.at))}</span> ${esc(n.text)}</li>`).join('')
        : lead ? `<li>${esc(lead)}</li>` : doRow && doRow[1] ? `<li>${esc(doRow[1])}</li>` : res ? `<li>${esc(res)}</li>` : `<li class="muted">${esc(t('work.nonotes'))}</li>`;
      return `<li class="thread st-${esc(x.status)}"><div class="thead"><span class="dot st-${esc(x.status)}"></span><button type="button" class="ptitle pick" data-action="select" data-id="${esc(x.id)}">${esc(tt(x))}</button>${newMark(x)}<span class="status st-${esc(x.status)}">${esc(stLabel(x.status))}</span></div>
        <ul class="tnotes">${lines}</ul></li>`;
    }).join('')}</ol>${more(live.length - lim)}` : `<p class="empty">${esc(t('work.empty'))}</p>`;
  },
  list(tasks, lim, g) {
    const open = tasks.filter((x) => x.status !== 'done' && x.status !== 'cancelled').sort(byOpen);
    const done = tasks.filter((x) => x.status === 'done').length;
    const doneLine = done ? `<p class="pmore">${esc(t('work.donecount', { n: done }))}</p>` : '';
    if (!g || !open.length) return `${listOrEmpty(statusTaskRows(open, lim), 'w.allclear')}${more(open.length - lim)}${doneLine}`;
    // Open cards grouped by milestone in the goal's order; empty or unknown milestones last under "no milestone".
    const known = new Set(g.milestones.map((m) => m.id));
    const groups = [...g.milestones.map((m) => ({ id: m.id, name: tt(m), ts: open.filter((x) => x.milestone === m.id) })),
      { id: 'none', name: t('ms.none'), ts: open.filter((x) => !known.has(x.milestone)) }].filter((x) => x.ts.length);
    return `${groups.map(({ id, name, ts }) => `<section class="msgroup" data-ms="${esc(id)}"><h3 class="msg-head">${esc(name)} <span class="n">${ts.length}</span></h3>
      <ul class="plist">${statusTaskRows(ts, lim).join('')}</ul>${more(ts.length - lim)}</section>`).join('')}${doneLine}`;
  },
  tree(tasks, lim, g) {
    const groups = g.milestones.map((m) => ({ m, ts: tasks.filter((x) => x.milestone === m.id) })).filter((x) => x.ts.length);
    if (!groups.length) return `<p class="empty">${esc(t('work.empty'))}</p>`;
    return `<ol class="ptree">${groups.map(({ m, ts }) => {
      const r = D.roll(m.id) || { pct: 0, done: 0, total: 0 };
      const open = workOpenTasks(ts);
      const done = ts.length - open.length;
      return `<li class="tbranch ms-${msState(m, r)}"><div class="tbhead"><span class="sname">${esc(tt(m))}</span><span class="counts">${r.done}/${r.total}</span>${pctBar(r.pct, r.late)}</div>
        ${open.length ? `<ul class="plist">${statusTaskRows(open, lim).join('')}</ul>${more(open.length - lim)}` : ''}
        ${done ? `<p class="pmore">${esc(t('work.donecount', { n: done }))}</p>` : ''}</li>`;
    }).join('')}</ol>`;
  },
};

/** "~/a/b/notes.md #24" -> "notes.md #24"; keeps the last path part of each " · "-separated source. */
const shortSource = (src) => String(src).split(' · ').map((p) => p.replace(/^.*\/(?=[^/\s]+(\s|$))/, '')).join(' · ');

const WIDGET = {
  // The goal's why and its profile (lib/profile.ts): what works today, what is missing. Agent-written text: escaped.
  profile(w, g) {
    const p = g.profile && typeof g.profile === 'object' ? g.profile : null;
    const arr = (x) => (Array.isArray(x) ? x.filter((i) => i && typeof i === 'object') : []);
    const feats = arr(p?.features), gaps = arr(p?.gaps).slice().sort((a, b) => (b.must === true) - (a.must === true));
    if (!g.why && !feats.length && !gaps.length) return '';
    const why = g.why ? `<p class="pf-why">${esc(g.why)}</p>` : '';
    const fl = feats.map((f) => `<li><b>${esc(String(f.area ?? ''))}</b> ${esc(String(f.text ?? ''))}${f.ref ? ` <span class="pf-ref">${esc(String(f.ref))}</span>` : ''}</li>`).join('');
    const gl = gaps.map((x) => `<li><span class="ds-badge"${x.must === true ? ' data-tone="warning"' : ''}>${esc(t(x.must === true ? 'profile.must' : 'profile.later'))}</span> ${esc(String(x.text ?? ''))}${x.why ? ` <span class="pf-ref">${esc(String(x.why))}</span>` : ''}</li>`).join('');
    const none = `<p class="empty">${esc(t('profile.none'))}</p>`;
    const meta = p ? t('profile.meta', { at: String(p.as_of ?? '').slice(0, 10), who: String(p.by ?? '') }) : '';
    const cols = p ? `<div class="pf-cols"><div><h3>${esc(t('profile.features'))}</h3>${fl ? `<ul>${fl}</ul>` : none}</div>
      <div><h3>${esc(t('profile.gaps'))}</h3>${gl ? `<ul>${gl}</ul>` : none}</div></div><p class="pf-meta">${esc(meta)}</p>` : '';
    return why + cols;
  },
  countdown(w) {
    const c = countdownOf(w);
    return `<div class="cd"><div class="cd-num">${esc(c.big)}</div><div class="cd-txt"><b>${esc(c.unit)}${c.small ? ` <span>${esc(c.small)}</span>` : ''}</b><span>${esc(loc(w, 'label') || t('cd.target'))} · ${esc(c.day)} ${esc(c.zone)}</span></div></div>`;
  },
  stats(w, g) {
    const tasks = appTasks(PAGE);
    const dayAgo = Date.now() - 86400000;
    const card = (label, value, delta, dir) => `<div class="ds-card stat-card"><div class="ds-stat"><span class="ds-stat-label">${esc(label)}</span>${value}${delta ? `<span class="ds-stat-delta"${dir ? ` data-dir="${dir}"` : ''}>${esc(delta)}</span>` : ''}</div></div>`;
    const num = (n) => `<span class="ds-stat-value${n === 0 ? ' zero' : ''}">${n}</span>`;
    const item = {
      progress: () => card(t('stat.progress'), ring(D.roll(PAGE)?.pct ?? 0, true)),
      needs_you: () => { const turn = turnOf(tasks); const p0 = turn.filter((x) => x.priority === 'p0').length; return card(t('stat.needs_you'), num(turn.length), p0 ? t('stat.p0', { n: p0 }) : '', 'down'); },
      running: () => { const run = runningOf(tasks); const st = run.filter(isStale).length; return card(t('stat.running'), num(run.length), st ? t('stat.stalled', { n: st }) : '', 'down'); },
      todo: () => card(t('stat.todo'), num(tasks.filter((x) => x.status === 'todo').length)),
      done: () => card(t('stat.done'), num(tasks.filter((x) => x.status === 'done').length)),
      done_24h: () => card(t('stat.done_24h'), num(tasks.filter((x) => x.status === 'done' && Date.parse(x.done_at || '') >= dayAgo).length), '', 'up'),
      countdown: () => { const c = countdownOf(w); return card(loc(w, 'label') || t('cd.target'), `<span class="ds-stat-value big">${esc(c.big)}<small>${esc(c.unit)}</small></span>`, c.day, 'down'); },
      stage: () => {
        const ms = g.milestones; const i = ms.findIndex((m) => msState(m, D.roll(m.id) || { pct: 0 }) !== 'done');
        if (i < 0) return card(t('stat.stage'), `<span class="ds-stat-value big">✓</span>`, t('w.allclear'), 'up');
        const { key, name } = stageParts(tt(ms[i]), i);
        return card(t('stat.stage'), `<span class="ds-stat-value big">${esc(key)}</span>`, name, 'up');
      },
    };
    const items = w.items || ['needs_you', 'running', 'todo', 'progress'];
    return `<div class="stats">${items.filter((k) => Object.hasOwn(item, k)).map((k) => item[k]()).join('')}</div>`;
  },
  needs_you(w, g, v, i) {
    // Top 5 (or the view's limit) in your-turn order (p0, then oldest); "more" shows the rest.
    return turnList(turnOf(appTasks(PAGE)), `w${i}`, true, w.limit || TURN_TOP);
  },
  running(w, g, v, i) {
    return missionList(runningOf(appTasks(PAGE)).sort(runningOrder), `w${i}`, true, w.limit || 6);
  },
  recent(w) {
    const since = Date.now() - (w.days || 1) * 86400000; const lim = w.limit || 8;
    const all = appTasks(PAGE).filter((x) => x.status === 'done' && Date.parse(x.updated) >= since).sort((a, b) => b.updated.localeCompare(a.updated));
    return listOrEmpty(all.slice(0, lim).map((x) => rowTask(x, `${esc(plainResult(resultLine(x)) || cardLead(x))} · ${esc(ago(x.updated))}`)), 'w.nofin') + more(all.length - lim);
  },
  stages(w, g) { const ms = pickMilestones(w, g); return planChart(ms) + stageTimeline(ms); },
  timeline(w, g) { const ms = pickMilestones(w, g); return planChart(ms) + stageTimeline(ms); },
  map(w, g) {
    const nodes = w.nodes || g.milestones.map((m) => ({ label: m.title, label_ko: m.title_ko, label_en: m.title_en, milestone: m.id }));
    const tasks = appTasks(PAGE);
    const sets = nodes.map((n) => tasks.filter((x) => (!n.milestone || x.milestone === n.milestone) && (!n.match || matches(x, n.match))));
    nodes.forEach((n, i) => {
      if (!n.rest) return;
      const taken = new Set(nodes.flatMap((o, j) => (j !== i && !o.rest && (!o.milestone || o.milestone === n.milestone) ? sets[j].map((x) => x.id) : [])));
      sets[i] = sets[i].filter((x) => !taken.has(x.id));
    });
    return `<ol class="pmap">${nodes.map((n, i) => {
      const ts = [...sets[i]].sort((a, b) => ST_ORDER[a.status] - ST_ORDER[b.status]);
      const done = ts.filter((x) => x.status === 'done').length;
      const need = needsOf(ts).length, run = runningOf(ts).length;
      const pct = ts.length ? Math.round((done / ts.length) * 100) : 0;
      const st = !ts.length ? 'planned' : done === ts.length ? 'done' : need ? 'blocked' : run ? 'active' : 'planned';
      return `<li class="mnode ms-${st}"><div class="mhead"><span class="mlabel">${esc(loc(n, 'label'))}</span><span class="mpct">${ts.length ? `${done}/${ts.length}` : '—'}</span></div>
        ${pctBar(pct)}
        <div class="swarm" role="img" aria-label="${esc(t('map.aria', { d: done, r: run, n: need, t: ts.length }))}">${ts.map((x) => `<i class="st-${esc(x.status)}" title="${esc(stLabel(x.status))}: ${esc(tt(x))}"></i>`).join('')}</div>
        ${need || run ? `<div class="mflags">${need ? `<span class="ds-badge" data-tone="warning">${esc(t('p.needyou', { n: need }))}</span>` : ''}${run ? `<span class="ds-badge">${esc(t('p.running', { n: run }))}</span>` : ''}</div>` : ''}</li>`;
    }).join('')}</ol>
    <p class="legend-s">${['done', 'doing', 'review', 'blocked-on-user', 'todo'].map((s) => `<span><i class="st-${s}"></i>${esc(stLabel(s))}</span>`).join('')}</p>`;
  },
  track(w) {
    const ids = w.milestones ? new Set(w.milestones) : null;
    const all = appTasks(PAGE).filter((x) => (!ids || ids.has(x.milestone)) && matches(x, w.match));
    const done = all.filter((x) => x.status === 'done').length;
    const open = workOpenTasks(all);
    const lim = w.limit || 8;
    const pct = all.length ? Math.round((done / all.length) * 100) : 0;
    return `<div class="trk"><div class="trk-num"><b>${done}<small>/${all.length}</small></b><span>${esc(t('trk.done'))}</span></div>${pctBar(pct)}
      <div class="trk-counts">${['blocked-on-user', 'review', 'doing', 'todo'].map((s) => { const n = all.filter((x) => x.status === s).length; return n ? `<span class="pill st-${s}">${n} ${esc(stLabel(s))}</span>` : ''; }).join('')}</div></div>
      ${listOrEmpty(statusTaskRows(open, lim), 'w.allclear')}${more(open.length - lim)}`;
  },
  apps() {
    return `<div class="pstrip in">${projects().filter((a) => a !== PAGE).map((a) => projectCard(a)).join('')}</div>`;
  },
  work(w, g, v) {
    const s = Object.hasOwn(WORK, v.structure) ? v.structure : 'list';
    return `${archiveNote(S.data.tasks.filter((x) => x.goal === PAGE))}${WORK[s](pageTasks(PAGE), w.limit || (s === 'kanban' ? 6 : s === 'threads' ? 10 : 12), g)}`;
  },
  ideas(w) {
    const all = S.ideas?.ideas || [];
    const open = all.filter((i) => i.status === 'open').reverse();
    const promoted = all.filter((i) => i.status === 'promoted');
    const lim = w.limit || 12;
    const row = (i) => {
      const src = safeUrl(i.source);
      const note = loc(i, 'note');
      return `<li class="idea"><span class="ibul" aria-hidden="true"></span><span class="pt"><span class="ptitle">${esc(tt(i))}</span>
        ${note ? `<span class="inote">${esc(note)}</span>` : ''}
        <span class="psub">${src ? `<a href="${esc(src)}" target="_blank" rel="noopener noreferrer">${esc(t('ideas.source'))}</a> · ` : i.source ? `<span title="${esc(i.source)}">${esc(shortSource(i.source))}</span> · ` : ''}${esc(t('ideas.by', { who: i.added_by, t: ago(i.added_at) }))}</span></span></li>`;
    };
    return `${open.length ? `<ul class="plist ideas">${open.slice(0, lim).map(row).join('')}</ul>` : `<p class="empty">${esc(t('ideas.empty'))}</p>`}${more(open.length - lim)}
      ${promoted.length ? `<p class="pmore">${esc(t('ideas.promoted', { n: promoted.length }))}: ${promoted.slice(-4).map((i) => `${esc(tt(i))} → <span class="mono">${esc(i.promoted_task_id)}</span>`).join(' · ')}</p>` : ''}`;
  },
  deps(w) { return depView(depGraph(appTasks(PAGE)), w); },
};

/** Days (or hours) to a countdown date: {big, unit, small, day, zone}. */
function countdownOf(w) {
  // Without tz the date is in the viewer's local time.
  const target = Date.parse(`${w.date}T${w.time || '00:00'}:00${w.tz || ''}`);
  const ms = target - Date.now();
  const [y, m, d] = String(w.date).split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(LANG === 'ko' ? 'ko-KR' : 'en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  let big, unit, small;
  if (ms <= 0) { const n = Math.floor(-ms / 86400000); big = n ? `+${n}` : '0'; unit = n === 1 ? t('cd.u.past1') : n ? t('cd.u.past') : t('cd.u.today'); small = ''; }
  else if (ms < 86400000) { big = Math.floor(ms / 3600000); unit = big === 1 ? t('cd.u.hour') : t('cd.u.hours'); small = t('unit.m', { n: Math.floor((ms % 3600000) / 60000) }); }
  else { big = Math.floor(ms / 86400000); unit = big === 1 ? t('cd.u.day') : t('cd.u.days'); small = t('unit.h', { n: Math.floor((ms % 86400000) / 3600000) }); }
  const zone = w.tz ? `(UTC${w.tz})` : t('cd.localtime');
  return { big: String(big), unit, small, day, zone };
}

/** "Step 1: Release build" -> {key: '1', name: 'Release build'}; "S1.0: …", "Stage 1a: …" and the Korean "0단계 …" alike.
 *  No key: '·'. */
function stageParts(title, i) {
  const m = /^(?:(?:Step|Stage)\s+)?(S?\d+(?:\.\d+)?[a-z]?)(?:단계)?\s*[:·.]?\s+(.+)$/i.exec(title) || /^(\d+)단계\s*(.+)$/.exec(title);
  return m ? { key: m[1], name: m[2] } : { key: '·', name: title };
}

/** Milestones as a ds-timeline: key, rail (done = green), title, then done/total · due (late in red) · waiting on you. */
function stageTimeline(ms) {
  if (!ms.length) return `<p class="empty">${esc(t('work.empty'))}</p>`;
  return `<div class="ds-timeline">${ms.map((m, i) => {
    const r = D.roll(m.id) || { pct: 0, done: 0, total: 0 };
    const st = msState(m, r);
    const { key, name } = stageParts(tt(m), i);
    const turn = S.data.tasks.filter((x) => x.milestone === m.id && isTurn(x)).length;
    const bits = [r.total ? `${r.done}/${r.total}` : esc(t(`ms.${m.status}`))];
    if (m.due) bits.push(r.late ? `<span class="ds-badge" data-tone="danger">${esc(t('due.late', { d: m.due.slice(5) }))}</span>` : esc(t('due', { d: m.due.slice(5) })));
    if (turn) bits.push(`<span class="ds-badge" data-tone="warning">${esc(t('home.turn.n', { n: turn }))}</span>`);
    return `<div class="ds-timeline-item ms-${st}"${st === 'done' ? ' data-state="done"' : ''}><span class="ds-tl-time">${esc(key)}</span><span class="ds-tl-rail"></span>
      <span class="ds-tl-body"><span class="ds-tl-title">${esc(name)}</span><span class="ds-tl-sub">${bits.join(' · ')}</span></span></div>`;
  }).join('')}</div>`;
}

// ---------- Stages: plan vs actual over the stage timeline ----------
// Milestones have a due day, cards do not, so a stage's plan runs from its first card's `created` to the milestone's due
// (end of that day, the reader's time zone). Actual runs to the last card's update when every card is done, else to now.
// "At this pace" uses the last 7 days' done count of the stage; no pace, no estimate.
const DAY = 86_400_000;
const dueEnd = (due) => { const ms = Date.parse(`${due}T23:59:59`); return Number.isFinite(ms) ? ms : null; };
/** Pure: milestones + the board's cards -> [{m, total, done, start, due, end, finished, eta}] (ms; null when unknown). */
function planRows(ms, tasks, now) {
  return ms.map((m) => {
    const ts = (tasks || []).filter((x) => x.milestone === m.id && x.status !== 'cancelled');
    const total = ts.length, done = ts.filter((x) => x.status === 'done').length;
    const starts = ts.map((x) => Date.parse(x.created)).filter(Number.isFinite);
    const finished = total > 0 && done === total;
    const ends = ts.map((x) => Date.parse(x.updated)).filter(Number.isFinite);
    const week = ts.filter((x) => x.status === 'done' && now - (Date.parse(x.updated) || 0) <= 7 * DAY).length;
    return { m, total, done, start: starts.length ? Math.min(...starts) : null, due: m.due ? dueEnd(m.due) : null,
      end: finished && ends.length ? Math.max(...ends) : now, finished, eta: !finished && week > 0 ? now + ((total - done) / (week / 7)) * DAY : null };
  });
}
const md = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };
function planChart(ms) {
  const now = Date.now();
  const rows = planRows(ms, S.data.tasks, now).filter((r) => r.start !== null);
  if (!rows.some((r) => r.due !== null)) return '';
  // The window: first start to the latest of due / end / estimate, an estimate shown at most 60 days out.
  const from = Math.min(...rows.map((r) => r.start));
  const to = Math.max(now + DAY, ...rows.map((r) => Math.max(r.due ?? 0, r.end, r.eta !== null ? Math.min(r.eta, now + 60 * DAY) : 0)));
  const W = 1000, L = 180, R = 940, RH = 28;
  const x = (v) => (L + ((v - from) / (to - from)) * (R - L)).toFixed(1);
  const body = rows.map((r, i) => {
    const y = 26 + i * RH, { key, name } = stageParts(tt(r.m), i);
    const label = `${key === '·' ? '' : `${key} `}${name.length > 16 ? `${name.slice(0, 15)}…` : name}`;
    const parts = [`<text class="pv-name" x="0" y="${y + 9}">${esc(label)}</text><text x="0" y="${y + 21}">${r.done}/${r.total}</text>`];
    if (r.due !== null) parts.push(`<rect class="pv-plan" x="${x(r.start)}" y="${y - 1}" width="${Math.max(1, x(r.due) - x(r.start)).toFixed(1)}" height="14" rx="3"/>`);
    if (r.finished) parts.push(`<rect class="pv-done" x="${x(r.start)}" y="${y + 1}" width="${Math.max(2, x(r.end) - x(r.start)).toFixed(1)}" height="10" rx="3"/>`);
    else {
      const cut = r.due !== null ? Math.min(r.end, Math.max(r.due, r.start)) : r.end;
      parts.push(`<rect class="pv-act" x="${x(r.start)}" y="${y + 1}" width="${Math.max(2, x(cut) - x(r.start)).toFixed(1)}" height="10" rx="3"/>`);
      if (r.due !== null && r.end > r.due) parts.push(`<rect class="pv-over" x="${x(Math.max(r.due, r.start))}" y="${y + 1}" width="${Math.max(1, x(r.end) - x(Math.max(r.due, r.start))).toFixed(1)}" height="10" rx="3"/>`);
      if (r.eta !== null) { const ex = Math.min(r.eta, to); parts.push(`<rect class="pv-eta" x="${x(now)}" y="${y + 2}" width="${Math.max(1, x(ex) - x(now)).toFixed(1)}" height="8" rx="3"/><text x="${(+x(ex) + 4).toFixed(1)}" y="${y + 10}">${esc(r.eta > to ? `${md(r.eta)}+` : md(r.eta))}</text>`); }
    }
    return `<g class="pv-row"><title>${esc(tt(r.m))}</title>${parts.join('')}</g>`;
  }).join('');
  const bottom = 26 + rows.length * RH;
  const ticks = [0, 1, 2, 3].map((k) => { const v = from + ((to - from) * k) / 3, tx = x(v); return `<line class="pv-grid" x1="${tx}" x2="${tx}" y1="16" y2="${bottom}"/><text x="${tx}" y="${bottom + 14}" text-anchor="middle">${md(v)}</text>`; }).join('');
  const late = rows.filter((r) => !r.finished && r.due !== null && now > r.due).length;
  const eta = rows.filter((r) => r.eta !== null).map((r) => r.eta);
  const head = `<div class="pv-head"><span class="pv-title">${esc(t('plan.title'))}</span>${late ? `<span class="ds-badge" data-tone="danger">${esc(t('plan.late', { n: late }))}</span>` : ''}${eta.length ? `<span class="ds-badge" data-tone="warning">${esc(t('plan.eta', { d: md(Math.max(...eta)) }))}</span>` : ''}</div>`;
  const legend = `<p class="pv-legend"><span><i class="plan"></i>${esc(t('plan.l.plan'))}</span><span><i class="act"></i>${esc(t('plan.l.act'))}</span><span><i class="over"></i>${esc(t('plan.l.over'))}</span><span><i class="done"></i>${esc(t('plan.l.done'))}</span><span><i class="eta"></i>${esc(t('plan.l.eta'))}</span></p>`;
  return `<div class="pv">${head}<div class="pv-box"><svg class="pv-svg" viewBox="0 0 ${W} ${bottom + 20}" role="img" aria-label="${esc(t('plan.aria', { n: rows.length, l: late }))}">${ticks}
    <line class="pv-now" x1="${x(now)}" x2="${x(now)}" y1="10" y2="${bottom}"/><text class="pv-nowt" x="${x(now)}" y="10" text-anchor="middle">${esc(t('plan.today'))}</text>${body}</svg></div>${legend}</div>`;
}

function pickMilestones(w, g) {
  if (!w.milestones) return g.milestones;
  return w.milestones.map((id) => g.milestones.find((m) => m.id === id)).filter(Boolean);
}

// ---------- Dependency graph (deps widget): depends_on drawn as layers, the longest open chain highlighted ----------
const isOpen = (x) => x.status !== 'done' && x.status !== 'cancelled';
/** Every id in depends_on, finished or not (same parsing as qvBlockers; the card itself never counts). */
function depIdsOf(x) {
  const raw = String(x.depends_on ?? '').replace(/#[\s\S]*$/, '');
  return [...new Set(raw.split(/[,\s]+/).map((v) => v.trim()).filter((v) => v && v.toLowerCase() !== 'none' && v !== x.id))];
}
/** The project's open cards that wait on something, and what they wait on (one hop: a dep's own deps are not followed
 *  unless it is an open card of this project too). Node: {id, task (null = unknown id), deps, layer, len, best}.
 *  layer = longest dep chain above it; len = open cards on the longest chain ending here (finished and unknown nodes
 *  count 0). An edge that closes a cycle is dropped (cut) so the rest still draws. chain = that longest chain, first
 *  card to do first, or [] when no open card waits on another open card. */
function depGraph(tasks) {
  const nodes = new Map(); const edges = []; const cut = new Set();
  const add = (id) => { if (!nodes.has(id)) nodes.set(id, { id, task: D.task(id) || null, deps: [] }); return nodes.get(id); };
  for (const x of tasks.filter(isOpen)) {
    const ids = depIdsOf(x); if (!ids.length) continue;
    add(x.id).deps = ids;
    for (const d of ids) { add(d); edges.push([d, x.id]); }
  }
  const state = new Map(); // 1 = on the current path, 2 = finished
  const visit = (n) => {
    state.set(n.id, 1); n.layer = 0; n.best = null;
    let above = 0;
    for (const d of n.deps) {
      if (state.get(d) === 1) { cut.add(`${d}>${n.id}`); continue; }
      const m = nodes.get(d); if (!state.has(d)) visit(m);
      n.layer = Math.max(n.layer, m.layer + 1);
      if (m.len > above) { above = m.len; n.best = d; }
    }
    n.len = (n.task && isOpen(n.task) ? 1 : 0) + above; state.set(n.id, 2);
  };
  for (const n of nodes.values()) if (!state.has(n.id)) visit(n);
  const prio = (n) => PRIO_RANK[n.task?.priority] ?? 9;
  const end = [...nodes.values()].sort((a, b) => b.len - a.len || prio(a) - prio(b) || a.id.localeCompare(b.id))[0];
  const chain = [];
  for (let n = end; n && end.len >= 2; n = n.best && nodes.get(n.best)) chain.unshift(n.id);
  return { nodes, edges, cut, chain };
}
/** Node size and gaps (px). Phones (box < 560px) stretch the nodes to fill the row, at least wPhone wide (two fit at 390px). */
const DG = { w: 184, h: 64, wPhone: 140, gap: 12, row: 12, layer: 34 };
/** Positions: one band per layer, top = do first; a band wider than the box wraps into rows. Inside a band, cards on
 *  the chain come first, then by the mean column of what they wait on (fewer crossings), then priority. Rows start at
 *  the left edge, so the gaps between columns line up from top to bottom: edges that skip rows run down them. */
function depLayout(g, avail) {
  const phone = avail < 560;
  const cols = Math.max(1, Math.floor((avail + DG.gap) / ((phone ? DG.wPhone : DG.w) + DG.gap)));
  const w = phone ? Math.min(220, Math.floor((avail - DG.gap * (cols - 1)) / cols)) : DG.w;
  const onChain = new Set(g.chain); const col = new Map(); const pos = new Map();
  const bands = [];
  for (const n of g.nodes.values()) (bands[n.layer] ||= []).push(n);
  let y = 0; let width = 0;
  for (const band of bands.filter(Boolean)) {
    const mean = (n) => { const cs = n.deps.filter((d) => col.has(d)).map((d) => col.get(d)); return cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : 0; };
    band.sort((a, b) => onChain.has(b.id) - onChain.has(a.id) || mean(a) - mean(b) || (PRIO_RANK[a.task?.priority] ?? 9) - (PRIO_RANK[b.task?.priority] ?? 9) || a.id.localeCompare(b.id));
    for (let i = 0; i < band.length; i += cols) {
      const row = band.slice(i, i + cols);
      row.forEach((n, j) => { col.set(n.id, j); pos.set(n.id, { j, x: j * (w + DG.gap), y }); });
      width = Math.max(width, row.length * (w + DG.gap) - DG.gap);
      y += DG.h + DG.row;
    }
    y += DG.layer - DG.row;
  }
  const rows = [...new Set([...pos.values()].map((p) => p.y))];
  return { pos, rows, w, h: DG.h, width, height: Math.max(0, y - DG.layer) };
}
function depView(g, w) {
  if (!g.edges.length) return w.auto ? '' : `<p class="empty">${esc(t('deps.none'))}</p>`;
  // Box width = #main's content box minus the section's padding and border (at most 20px + 0.5px a side); a half-width
  // widget gets one of the two .pgrid columns (16px apart) above 760px, where the grid has two.
  const main = document.querySelector('#main'); const cs = main && window.getComputedStyle?.(main);
  let inner = main?.clientWidth ? main.clientWidth - (parseFloat(cs?.paddingLeft) || 0) - (parseFloat(cs?.paddingRight) || 0) : 1000;
  if (w.span === 'half' && window.innerWidth > 760) inner = (inner - 16) / 2;
  const L = depLayout(g, Math.max(260, inner - 42));
  const onChain = new Set(g.chain);
  const chainEdge = new Set(g.chain.slice(1).map((id, i) => `${g.chain[i]}>${id}`));
  const kind = (n) => (!n.task ? 'missing' : !isOpen(n.task) ? 'finished' : n.task.goal !== PAGE ? 'other' : 'open');
  const edges = g.edges.map(([a, b]) => {
    const p = L.pos.get(a), q = L.pos.get(b);
    const x1 = p.x + L.w / 2, y1 = p.y + L.h, x2 = q.x + L.w / 2, y2 = q.y, dy = Math.max(14, (y2 - y1) / 2);
    // Rows in between: leave through the gap under the source row, run down the column gap beside the target, enter
    // through the gap above it, so the line never passes behind another card.
    const skips = L.rows.some((r) => r > p.y && r < q.y);
    const gx = q.j > 0 ? q.x - DG.gap / 2 : q.x + L.w + DG.gap / 2;
    const route = skips ? `M${x1} ${y1}V${y1 + DG.row / 2}H${gx}V${y2 - DG.row / 2}H${x2}V${y2 - 5}`
      : `M${x1} ${y1}C${x1} ${y1 + dy} ${x2} ${y2 - dy} ${x2} ${y2 - 5}`;
    const k = `${a}>${b}`; const from = kind(g.nodes.get(a));
    const cls = [chainEdge.has(k) ? 'crit' : '', g.cut.has(k) ? 'cut' : '', from === 'missing' ? 'missing' : from === 'finished' ? 'finished' : ''].filter(Boolean).join(' ');
    // A cut edge points up (it closes a cycle): drawn as a dashed straight line, no arrow.
    return g.cut.has(k) ? `<path class="${cls}" d="M${x2} ${y2}L${x1} ${y1}"/>`
      : `<path class="${cls}" d="${route}"/><path class="tip ${cls}" d="M${x2 - 4} ${y2 - 7}L${x2 + 4} ${y2 - 7}L${x2} ${y2}Z"/>`;
  }).join('');
  // DOM order = reading order (band by band, left to right), so Tab follows the picture.
  const order = [...g.nodes.values()].sort((a, b) => L.pos.get(a.id).y - L.pos.get(b.id).y || L.pos.get(a.id).x - L.pos.get(b.id).x);
  const nodes = order.map((n) => {
    const p = L.pos.get(n.id); const k = kind(n); const crit = onChain.has(n.id);
    const style = `left:${p.x}px;top:${p.y}px;width:${L.w}px;height:${L.h}px`;
    if (k === 'missing') return `<div class="dg-node missing" style="${style}" title="${esc(n.id)}"><span class="dg-t mono">${esc(n.id)}</span><span class="dg-s">${esc(t('deps.missing'))}</span></div>`;
    const x = n.task; const where = k === 'other' ? ` · ${esc(appName(x.goal))}` : '';
    const label = `${tt(x)} · ${stLabel(x.status)}${crit ? ` · ${t('deps.onchain')}` : ''}`;
    return `<button type="button" class="dg-node st-${esc(x.status)} ${k}${crit ? ' crit' : ''}" style="${style}" data-action="select" data-id="${esc(n.id)}" aria-label="${esc(label)}" title="${esc(tt(x))}">
      <span class="dg-t">${esc(tt(x))}</span><span class="dg-s"><span class="dot st-${esc(x.status)}"></span>${esc(stLabel(x.status))}${where}</span></button>`;
  }).join('');
  const missing = [...g.nodes.values()].filter((n) => !n.task).length;
  const notes = [missing ? t('deps.missing.n', { n: missing }) : '', g.cut.size ? t('deps.cycle', { n: g.cut.size }) : ''].filter(Boolean);
  const chain = g.chain.length
    ? `<p class="dg-chain"><b>${esc(t('deps.chain', { n: g.chain.length }))}</b> ${g.chain.map((id) => `<button type="button" class="dg-pick" data-action="select" data-id="${esc(id)}">${esc(tt(D.task(id)))}</button>`).join('<span aria-hidden="true"> → </span>')}</p>`
    : `<p class="dg-chain muted">${esc(t('deps.nochain'))}</p>`;
  return `${chain}<div class="dg-wrap"><div class="dg-canvas" role="group" aria-label="${esc(t('deps.aria', { n: g.nodes.size }))}" style="width:${L.width}px;height:${L.height}px">
    <svg class="dg-edges" width="${L.width}" height="${L.height}" aria-hidden="true">${edges}</svg>${nodes}</div></div>
    <p class="legend-s dg-legend"><span><i class="crit"></i>${esc(t('deps.l.chain'))}</span><span><i class="finished"></i>${esc(t('deps.l.finished'))}</span><span><i class="missing"></i>${esc(t('deps.l.missing'))}</span>${notes.length ? `<span>${esc(notes.join(' · '))}</span>` : ''}</p>`;
}

// The countdown, "ago" labels and "stalled?" flags drift: refresh project pages, home and Today once a minute
// (render() keeps a comment being typed on Today and never redraws a side panel with unsaved edits).
setInterval(() => { if (S.data && !document.hidden && (PAGE || S.view === 'home' || S.view === 'today')) render(); }, 60_000);

applyStatic();
window.addEventListener('hashchange', route);
refreshAuth();
load().then(() => { route(); connect(); }).catch((e) => { $('#main').innerHTML = `<p class="empty">${esc(t('load.fail', { e: e.message }))}</p>`; });

// Dasks HTTP client shared by the MCP server (dasks-mcp.mjs) and the `dasks` CLI (board-cli.mjs). Zero dependencies.
// Board URL and token: src/lib/connection.mjs (env, else ~/.dasks/client.json). DASKS_ACTOR names the writer.
import { randomUUID } from 'node:crypto';
import { authHeader, boardToken, boardUrl, machineName, trustBoardCa } from '../src/lib/connection.mjs';

export { authHeader, machineName };
export const ACTOR_RE = /^[A-Za-z0-9._@-]{1,40}$/;
export const STATUSES = ['todo', 'doing', 'review', 'blocked-on-user', 'done', 'cancelled'];
export const CONTEXT_FIELDS = ['what', 'why', 'do', 'rec', 'after'];
export const STRUCTURES = ['kanban', 'threads', 'list', 'tree'];
export const IDEA_STATUSES = ['open', 'promoted', 'dropped'];
export const LESSON_STATUSES = ['proposed', 'confirmed', 'retired'];
/** The keys tasks() reads from each card (its output plus i18n). */
const TASK_LIST_FIELDS = ['id', 'title', 'title_ko', 'title_en', 'status', 'owner', 'claimed_by', 'lane', 'kind', 'priority', 'version', 'updated', 'pr', 'now', 'now_at'];
const i18n = (o) => ({ ...(o.title_ko ? { title_ko: o.title_ko } : {}), ...(o.title_en ? { title_en: o.title_en } : {}) });

export const envActor = () => process.env.DASKS_ACTOR || '';
/** Waits between attempts when the board refuses the connection (it is restarting). Total about 4.5 s. */
export const RETRY_DELAYS_MS = [150, 300, 600, 1200, 2200];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const MSG_KINDS = ['question', 'answer', 'fyi', 'blocked-on', 'heads-up'];
export const MAX_WAIT_S = 600;
/** Roles this actor answers to besides its own name: DASKS_ROLES (comma list), else "human" for interactive sessions. */
export function myRoles(actor) {
  const env = process.env.DASKS_ROLES;
  if (env !== undefined) return env.split(',').map((s) => s.trim()).filter(Boolean);
  return /^(human|claude-code|codex|user)\b/.test(actor || '') ? ['human'] : [];
}

/** One interactive session writes under two names on one machine: <mcp>@M (this MCP, DASKS_ACTOR) and human-<tool>@M
 *  (the dask CLI). Both are "me" for to_me; bin/dask has the same rule. */
const SESSION_NAMES = [['claude-code', 'human-claude'], ['codex', 'human-codex']];
export function myNames(actor) {
  const i = (actor || '').indexOf('@');
  if (i < 0) return actor ? [actor] : [];
  const name = actor.slice(0, i), mach = actor.slice(i + 1);
  const pair = SESSION_NAMES.find((p) => p.includes(name));
  return pair ? [actor, ...pair.filter((n) => n !== name).map((n) => `${n}@${mach}`.slice(0, 40))] : [actor];
}

export class BoardError extends Error {
  constructor(status, data) {
    super(`${status} ${data?.error ?? data}`);
    this.status = status; this.data = data;
  }
}

/** beta.i-foo -> beta */
export const appOfId = (id) => String(id ?? '').split('.')[0];

export function client({ url = boardUrl(), actor = envActor(), token = boardToken(), retryDelays = RETRY_DELAYS_MS } = {}) {
  trustBoardCa(); // also when the caller passed the URL
  const base = url.replace(/\/+$/, '');
  if (actor && !ACTOR_RE.test(actor)) throw new Error(`DASKS_ACTOR "${actor}" is invalid (letters, digits, . _ @ -, max 40)`);
  if (actor === 'user') throw new Error('DASKS_ACTOR "user" is reserved for the human in the board UI; use your own name, e.g. claude-code@my-mac');
  const auth = authHeader(token); // checked once, up front: a bad value fails here, never inside fetch

  async function req(method, path, body, timeoutMs = 20_000) {
    const write = method !== 'GET';
    if (write && !actor) throw new Error('DASKS_ACTOR is not set; writes must name the actor (e.g. claude-code@my-mac)');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const started = Date.now();
    const send = () => fetch(base + path, {
      method, signal: ctl.signal,
      headers: { ...(actor ? { 'X-Dasks-Actor': actor } : {}), ...auth, ...(write ? { 'Content-Type': 'application/json' } : {}) },
      body: write ? JSON.stringify(body ?? {}) : undefined,
    });
    let r, data;
    // The timer covers the whole exchange, body included.
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          r = await send();
          break;
        } catch (e) {
          // A refused connection never reached the server (it is restarting), so even a write is safe to send again.
          // Reads also retry a reset connection. Anything else (timeout, DNS, no route) fails at once.
          const code = e.cause?.code;
          const retry = e.name !== 'AbortError' && (code === 'ECONNREFUSED' || (!write && (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET')));
          if (retry && attempt < retryDelays.length) { await sleep(retryDelays[attempt]); continue; }
          throw new Error(`dasks board unreachable at ${base} (${e.name === 'AbortError' ? 'timeout' : code || e.message}); is the board running?`);
        }
      }
      // 503 = the board wrote nothing (repo busy or git failing): wait as told and try again, twice at most.
      // (Only while there is time left in the 20 s budget: a 503 after a 15 s lock wait is returned as is.)
      for (let busy = 0; r.status === 503 && busy < 2 && Date.now() - started < 12_000; busy++) {
        const wait = Math.min(5, Number(r.headers.get('retry-after')) || 1) * 1000;
        try { await r.body?.cancel(); } catch { /* already read */ }
        await sleep(wait);
        r = await send();
      }
      const ct = r.headers.get('content-type') || '';
      try { data = ct.includes('json') ? await r.json() : await r.text(); }
      catch (e) { throw new Error(`dasks board response from ${base} failed (${e.name === 'AbortError' ? 'timeout' : e.message})`); }
    } finally { clearTimeout(timer); }
    if (!r.ok) throw new BoardError(r.status, data);
    const w = r.headers.get('x-dasks-warning');
    if (w && data && typeof data === 'object' && !Array.isArray(data)) data.warnings = [...new Set([...(data.warnings || []), ...decodeURIComponent(w).split('; ')])];
    return data;
  }

  const enc = encodeURIComponent;
  const qs = (o) => {
    const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length))
      .map(([k, v]) => `${k}=${enc(Array.isArray(v) ? v.join(',') : String(v))}`);
    return p.length ? `?${p.join('&')}` : '';
  };
  /** to_me: messages to either of my names, to everyone, or to one of my roles; never from either of my names
   *  (the board's not_from takes one name, so the other is dropped here). */
  const names = myNames(actor);
  const msgFilter = (f) => {
    const to = f.to_me ? [...new Set([...names, '*', ...myRoles(actor)].filter(Boolean))] : f.to;
    return { since: f.since ?? 0, to, kind: f.kind, reply_to: f.reply_to, not_from: f.to_me ? actor || undefined : undefined, limit: f.limit };
  };
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

  return {
    url: base, actor,
    async goals() {
      const b = await req('GET', '/api/board');
      const roll = new Map(); for (const g of b.rollup?.goals ?? []) { roll.set(g.id, g.pct); for (const m of g.milestones ?? []) roll.set(m.id, m.pct); }
      return {
        northstar: b.northstar ? { id: b.northstar.id, title: b.northstar.title } : null,
        goals: b.goals.map((g) => ({
          app: g.id, title: g.title, ...i18n(g), owner: g.owner, ...(g.repo ? { repo: g.repo } : {}), pct: roll.get(g.id) ?? 0,
          ...(g.profile?.as_of ? { profile_as_of: g.profile.as_of } : {}),
          milestones: g.milestones.map((m) => ({ id: m.id, title: m.title, ...i18n(m), status: m.status, due: m.due || '', pct: roll.get(m.id) ?? 0 })),
        })),
      };
    },
    async tasks(f = {}) {
      // fields=: only the keys mapped below (no bodies).
      const list = await req('GET', '/api/tasks' + qs({ goal: f.app, status: f.status, owner: f.owner, lane: f.lane, kind: f.kind, milestone: f.milestone, fields: TASK_LIST_FIELDS }));
      let out = list;
      if (f.claimed_by) out = out.filter((t) => t.claimed_by === f.claimed_by);
      if (f.query) { const q = String(f.query).toLowerCase(); out = out.filter((t) => `${t.id} ${t.title}`.toLowerCase().includes(q)); }
      return out.map((t) => ({ id: t.id, title: t.title, ...i18n(t), status: t.status, owner: t.owner, claimed_by: t.claimed_by || '', lane: t.lane, kind: t.kind, priority: t.priority, version: t.version ?? 0, updated: t.updated, ...(t.pr ? { pr: t.pr } : {}), ...(t.now ? { now: t.now, now_at: t.now_at || '' } : {}) }));
    },
    /** One task. f.log = how many newest activity entries (0..50; omitted = the server's 50). */
    task: (id, f = {}) => req('GET', `/api/tasks/${enc(id)}` + qs({ log: f.log })),
    // Card messages (information only: they never approve, pass, merge or launch anything).
    participants: (id) => req('GET', `/api/tasks/${enc(id)}/participants`),
    postMessage: (id, m) => req('POST', `/api/tasks/${enc(id)}/messages`, clean({ request_id: m.request_id ?? randomUUID(), to: m.to, kind: m.kind, reply_to: m.reply_to, text: m.text, job_id: m.job_id })),
    async messages(id, f = {}) {
      const r = await req('GET', `/api/tasks/${enc(id)}/messages` + qs(msgFilter(f)));
      return f.to_me ? { ...r, messages: r.messages.filter((m) => !names.includes(m.from)) } : r;
    },
    /** Long-poll up to f.timeout seconds (≤600) in server slices of ≤55 s. Resolves {timed_out, messages, last_seq}. */
    async waitMessages(id, f = {}) {
      const total = Math.max(0, Math.min(MAX_WAIT_S, Number.isFinite(Number(f.timeout)) ? Number(f.timeout) : 55));
      const end = Date.now() + total * 1000;
      let since = f.since ?? 0;
      for (;;) {
        const left = Math.ceil((end - Date.now()) / 1000);
        const slice = Math.max(0, Math.min(55, left));
        const r = await req('GET', `/api/tasks/${enc(id)}/messages/wait` + qs({ ...msgFilter({ ...f, since }), timeout: slice }), undefined, (slice + 20) * 1000);
        const got = f.to_me ? r.messages.filter((m) => !names.includes(m.from)) : r.messages;
        if (got.length) return { ...r, messages: got };
        if (!r.messages.length && left <= slice) return r;
        if (r.messages.length) since = Math.max(...r.messages.map((m) => m.seq)); // only my other name spoke: keep waiting after it
        if (Date.now() >= end) return { ...r, timed_out: true, messages: [] };
      }
    },
    /** Unblocked todo tasks ranked by how many tasks they unblock: {ready, blocked, cycles}. */
    stuck: () => req('GET', '/api/stuck'),
    /** One-call loop start (text lines): rules, unread messages, mine, ready, review. rules:false skips the rules; peek leaves messages unread. */
    start(f = {}) {
      // An explicitly empty DASKS_ROLES is sent as roles= (no roles), not left out (the server's default role list).
      const roles = myRoles(actor), q = qs({ app: f.app, repo: f.repo, rules: f.rules === false ? 0 : undefined, ready: f.ready, peek: f.peek ? 1 : undefined, spec_ready: f.spec_ready ? 1 : undefined, roles });
      return req('GET', '/api/start' + (roles.length ? q : `${q}${q ? '&' : '?'}roles=`));
    },
    /** Spec-ready cards only, unless all (then every unblocked todo card, any spec state). */
    ready: (f = {}) => req('GET', '/api/ready' + qs({ goal: f.app, limit: f.limit, all: f.all ? 1 : undefined, require_spec_ready: f.require_spec_ready ? 1 : undefined })),
    /** Todo intake report: {total, by_goal, by_creator, by_id_family, by_spec_state, created_last_24h}. */
    intake: (f = {}) => req('GET', '/api/intake' + qs({ goal: f.app })),
    create: (fields) => req('POST', '/api/tasks', clean(fields)),
    update: (id, fields) => req('POST', `/api/tasks/${enc(id)}`, clean(fields)),
    claim: (id, o = {}) => req('POST', `/api/tasks/${enc(id)}/claim`, clean(o)),
    release: (id, o = {}) => req('POST', `/api/tasks/${enc(id)}/release`, clean(o)),
    finish: (id, o = {}) => req('POST', `/api/tasks/${enc(id)}/finish`, clean(o)),
    resetAttempts: (id, o = {}) => req('POST', `/api/tasks/${enc(id)}/reset-attempts`, clean(o)),
    /** Card spec store: the current spec or version N; a write sends the version it read (0 for the first). */
    spec: (id, { version } = {}) => req('GET', `/api/tasks/${enc(id)}/spec${qs({ version })}`),
    putSpec: (id, o) => req('PUT', `/api/tasks/${enc(id)}/spec`, clean(o)),
    /** Spec state: the text review of any card, and Spec blocks. */
    reviewSpec: (id, o) => req('POST', `/api/tasks/${enc(id)}/spec/review`, o),
    blockSpec: (id, o) => req('POST', `/api/tasks/${enc(id)}/spec/block`, o),
    unblockSpec: (id, o) => req('POST', `/api/tasks/${enc(id)}/spec/unblock`, o),
    board: () => req('GET', '/api/board'),
    /** Goal / milestone / north star fields (title, title_ko, title_en, …). */
    updateNode: (id, fields) => req('POST', `/api/nodes/${enc(id)}`, clean(fields)),
    /** A project's why and profile: what works today, what is missing (null when never written). */
    async profile(app) {
      const b = await req('GET', '/api/board');
      const g = b.goals.find((x) => x.id === app);
      if (!g) throw new Error(`no project "${app}"`);
      return { app: g.id, title: g.title, ...i18n(g), why: g.why || '', ...(g.repo ? { repo: g.repo } : {}), profile: g.profile ?? null };
    },
    /** Replace the profile (null removes it) and, optionally, the goal's why and titles in the same commit. */
    setProfile: (app, { profile, ...fields }) => req('POST', `/api/nodes/${enc(app)}`, { ...clean(fields), profile: profile ?? null }),
    /** Change only a project's structure: kanban | threads | list | tree. */
    setStructure: (app, structure, expected_version) => req('POST', `/api/views/${enc(app)}/structure`, clean({ structure, expected_version })),
    ideaSummaries: () => req('GET', '/api/ideas'),
    ideas: (app, status) => req('GET', `/api/ideas/${enc(app)}` + qs({ status })),
    addIdea: (app, fields) => req('POST', `/api/ideas/${enc(app)}`, clean(fields)),
    updateIdea: (id, fields) => req('POST', `/api/ideas/${enc(appOfId(id))}/${enc(id)}`, clean(fields)),
    promoteIdea: (id, fields = {}) => req('POST', `/api/ideas/${enc(appOfId(id))}/${enc(id)}/promote`, clean(fields)),
    lessonSummaries: () => req('GET', '/api/lessons'),
    lessons: (app, f = {}) => req('GET', `/api/lessons/${enc(app)}` + qs({ status: f.status, files: Array.isArray(f.files) ? f.files.join(',') : f.files, limit: f.limit })),
    addLesson: (app, fields) => req('POST', `/api/lessons/${enc(app)}`, clean(fields)),
    updateLesson: (id, fields) => req('POST', `/api/lessons/${enc(appOfId(id))}/${enc(id)}`, clean(fields)),
    // check items
    getItems: (id, { history } = {}) => req('GET', `/api/tasks/${enc(id)}/items` + qs({ history: history ? 1 : undefined })),
    seedItems: (id, fields = {}) => req('POST', `/api/tasks/${enc(id)}/items/seed`, clean(fields)),
    reportItem: (id, n, fields) => req('POST', `/api/tasks/${enc(id)}/items/${enc(String(n))}`, clean(fields)),
    // fleet and captain (docs/fleet.md, docs/captain.md)
    fleet: () => req('GET', '/api/fleet'),
    // backup, review triage, daily summary (docs/upgrade.md, docs/api.md)
    backup: () => req('GET', '/api/backup'),
    backupNow: () => req('POST', '/api/backup/now', {}),
    reviewTriage: () => req('GET', '/api/review-triage'),
    summary: () => req('GET', '/api/summary'),
    captain: () => req('GET', '/api/captain'),
    chat: (since = 0) => req('GET', `/api/captain/chat${qs({ since })}`),
    chatReply: (text, lease_id) => req('POST', '/api/captain/chat', { text, lease_id }),
    leaseCheck: (lease_id) => req('POST', '/api/captain/lease/check', { lease_id }),
    lease: (o = {}) => req('POST', '/api/captain/lease', clean(o)),
    releaseLease: (lease_id) => req('POST', '/api/captain/lease/release', { lease_id }),
    views: () => req('GET', '/api/views'),
    view: (app) => req('GET', `/api/views/${enc(app)}`),
    /** Replace a project's view: {title?, tagline?, widgets}. expected_version (from view()) guards against lost updates. */
    setView: (app, view, expected_version) => {
      // Drop what GET adds around the view, so a fetched view can be edited and sent back as is.
      const { url: _u, activity: _a, version: _v, updated: _t, updated_by: _b, default: _d, widget_catalog: _w, ...rest } = view ?? {};
      return req('PUT', `/api/views/${enc(app)}`, clean({ ...rest, expected_version }));
    },
  };
}

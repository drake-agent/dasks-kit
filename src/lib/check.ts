// `dasks check`: schema, unknown ids, dangling links, one goal per app (plus any extra goals under the north star).
import path from 'node:path';
import { APPROVALS, type Board, DATE_RE, GOAL_ID_RE, REQUIRED_GOAL_IDS, type Issue, MAX_TITLE_LEN, KINDS, LINK_TYPES, ALL_STATUSES, MAX_RESULT_LINES, MAX_SUMMARY_LINES, MAX_SUMMARY_LINE, MAX_SUMMARY_CHARS, MAX_NOW_CHARS, MAX_TASK_BYTES, MILESTONE_ID_RE, MILESTONE_STATUSES, NORTHSTAR_ID, PRIORITIES, STARTED_BY, type Task, TASK_FIELDS, TASK_ID_RE, MAX_ID_LEN, ACTOR_RE, SECRET_LABEL_RE, MAX_SECRETS, SPEC_STATES, isFamily, VERDICTS, MAX_BLOCK_NOTE_BYTES } from './schema.ts';
import { isAllowedLane } from './lanes.ts';
import { parsePush } from './push.ts';
import { cleanStoredProfile } from './profile.ts';

export interface CheckResult { errors: Issue[]; warnings: Issue[] }

export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export function isValidTimestamp(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(s) && !Number.isNaN(Date.parse(s));
}
export function isHttpUrl(s: string): boolean {
  try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
}

/** Validate one task in isolation (shape only). `idx` enables reference checks (milestone -> goal, known goal ids). */
export function checkTask(t: Task, idx?: { milestones: Map<string, string>; goals?: Set<string> }): string[] {
  const e: string[] = [];
  const present: string[] = (t as any).__present ?? Object.keys(t);
  for (const k of TASK_FIELDS) {
    if (k === 'pr') continue;
    if (!present.includes(k)) e.push(`missing field "${k}"`);
  }
  for (const k of ((t as any).__unknown ?? []) as string[]) e.push(`unknown field "${k}"`);
  if (!t.id || t.id.length > MAX_ID_LEN || !TASK_ID_RE.test(t.id)) e.push(`bad id "${t.id}" (want <goal>.t-<slug>)`);
  if (!t.title?.trim()) e.push('title is empty');
  const knownGoal = idx?.goals ? idx.goals.has(t.goal) : GOAL_ID_RE.test(t.goal ?? '');
  if (!knownGoal) e.push(`unknown goal "${t.goal}"`);
  else if (t.id && !t.id.startsWith(t.goal + '.')) e.push(`id "${t.id}" does not start with goal "${t.goal}."`);
  if (t.file) {
    const parts = t.file.split(path.sep);
    const folder = parts[parts.length - 2];
    const base = parts[parts.length - 1].replace(/\.md$/, '');
    if (folder !== t.goal) e.push(`file is in tasks/${folder}/ but goal is "${t.goal}"`);
    if (t.id && base !== t.id.slice(t.goal.length + 1)) e.push(`file name "${base}.md" must equal the id's local part "${t.id.slice(t.goal.length + 1)}.md"`);
  }
  if (!t.milestone) e.push('milestone is empty');
  else if (idx) {
    const g = idx.milestones.get(t.milestone);
    if (g === undefined) e.push(`unknown milestone "${t.milestone}"`);
    else if (g !== t.goal) e.push(`milestone "${t.milestone}" belongs to goal "${g}", not "${t.goal}"`);
  }
  if (!t.owner?.trim()) e.push('owner is empty');
  if (!isAllowedLane(t.lane)) e.push(`bad lane "${t.lane}"`);
  if (!(KINDS as readonly string[]).includes(t.kind)) e.push(`bad kind "${t.kind}"`);
  if (!(ALL_STATUSES as readonly string[]).includes(t.status)) e.push(`bad status "${t.status}"`);
  if (!(PRIORITIES as readonly string[]).includes(t.priority)) e.push(`bad priority "${t.priority}"`);
  if (!(APPROVALS as readonly string[]).includes(t.approvals)) e.push(`bad approvals "${t.approvals}"`);
  if (!(STARTED_BY as readonly string[]).includes(t.started_by)) e.push(`bad started_by "${t.started_by}"`);
  for (const k of ['title_ko', 'title_en'] as const) {
    const v = t[k];
    if (v !== undefined && v !== '' && (!v.trim() || v.length > MAX_TITLE_LEN || /[\r\n]/.test(v))) e.push(`${k} must be one line of 1-${MAX_TITLE_LEN} characters`);
  }
  if (t.idea && !/^[a-z][a-z0-9]{0,23}\.i-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t.idea)) e.push(`bad idea "${t.idea}" (want <goal>.i-<slug>)`);
  if (t.depends_on) {
    const ds = String(t.depends_on).split(/[\s,]+/).filter(Boolean);
    for (const d of ds) if (d.length > MAX_ID_LEN || !TASK_ID_RE.test(d)) e.push(`depends_on: bad task id "${d}"`);
    if (ds.includes(t.id)) e.push('depends_on: a task cannot depend on itself');
    if (ds.length > 20) e.push('depends_on: at most 20 ids');
  }
  if (t.secrets) {
    const ls = String(t.secrets).split(/[\s,]+/).filter(Boolean);
    // Never echo the rejected text: a pasted value must not come back in an error.
    ls.forEach((l, i) => { if (!SECRET_LABEL_RE.test(l)) e.push(`secrets: item ${i + 1} is not a secret label name`); });
    if (ls.length > MAX_SECRETS) e.push(`secrets: at most ${MAX_SECRETS} labels`);
  }
  if (t.pr && !isHttpUrl(t.pr)) e.push(`pr must be a URL, got "${t.pr}"`);
  if (t.pr_summary && /\n\s*\n/.test(t.pr_summary.trim())) e.push('pr_summary must be one paragraph');
  if (t.result && t.result.trim().split('\n').length > MAX_RESULT_LINES) e.push(`result is over ${MAX_RESULT_LINES} lines`);
  if (t.summary) {
    const ls = t.summary.trim().split('\n');
    if (ls.length > MAX_SUMMARY_LINES) e.push(`summary is over ${MAX_SUMMARY_LINES} lines`);
    if (ls.some((l) => l.length > MAX_SUMMARY_LINE)) e.push(`summary has a line over ${MAX_SUMMARY_LINE} characters`);
    if (t.summary.length > MAX_SUMMARY_CHARS) e.push(`summary is over ${MAX_SUMMARY_CHARS} characters`);
  }
  if (t.summary_by && !ACTOR_RE.test(t.summary_by)) e.push(`bad summary_by "${t.summary_by}"`);
  if (t.summary_at && !isValidTimestamp(t.summary_at)) e.push(`bad summary_at "${t.summary_at}"`);
  if (t.now && /[\r\n]/.test(t.now)) e.push('now is more than one line');
  if (t.now && t.now.length > MAX_NOW_CHARS) e.push(`now is over ${MAX_NOW_CHARS} characters`);
  if (t.now_by && !ACTOR_RE.test(t.now_by)) e.push(`bad now_by "${t.now_by}"`);
  if (t.now_at && !isValidTimestamp(t.now_at)) e.push(`bad now_at "${t.now_at}"`);
  if (t.status === 'blocked-on-user' && !t.needs_user?.trim()) e.push('status blocked-on-user requires needs_user');
  for (const k of ['created', 'updated'] as const) if (!isValidTimestamp(t[k] ?? '')) e.push(`bad ${k} "${t[k]}"`);
  if (t.started_at && !isValidTimestamp(t.started_at)) e.push(`bad started_at "${t.started_at}"`);
  if (t.lane === 'failed-terminal' && t.status !== 'blocked-on-user') e.push('failed-terminal requires blocked-on-user');
  for (const k of ['attempt', 'reset_epoch'] as const) if (t[k] && !/^\d{1,9}$/.test(t[k])) e.push(`bad ${k} "${t[k]}"`);
  if (t.run_id && (!/^[a-f0-9-]{36}$/.test(t.run_id) || !t.attempt || Number(t.attempt) < 1)) e.push('run_id requires a server id and positive attempt');
  if (t.version && !/^\d{1,9}$/.test(t.version)) e.push(`bad version "${t.version}"`);
  if (t.claimed_at && !isValidTimestamp(t.claimed_at)) e.push(`bad claimed_at "${t.claimed_at}"`);
  if (t.claim_seen && !isValidTimestamp(t.claim_seen)) e.push(`bad claim_seen "${t.claim_seen}"`);
  if (t.claimed_by && !ACTOR_RE.test(t.claimed_by)) e.push(`bad claimed_by "${t.claimed_by}"`);
  // Shape only: a push left on a card that moved on is ignored by readyQueue and cleared by the next server write.
  if (t.pushed && !parsePush(t.pushed)) e.push(`bad pushed "${t.pushed}" (want "<ISO time> <actor> <lane>")`);
  e.push(...specFieldErrors(t, present));
  return e;
}

/** Server time on the board: `YYYY-MM-DDTHH:mm:ss±HH:MM`. */
export function isServerTime(s: unknown): boolean {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}
/** The block note: one line of 1..1,024 UTF-8 bytes. */
export function blockNoteError(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim() || /[\r\n]/.test(v) || !v.isWellFormed()) return 'block_note must be one line of text';
  if (Buffer.byteLength(v, 'utf8') > MAX_BLOCK_NOTE_BYTES) return `block_note is over ${MAX_BLOCK_NOTE_BYTES} bytes`;
  return null;
}
/** Spec state and block fields. The loader keeps spec_review / blocked_spec_version raw. */
function specFieldErrors(t: Task, present: string[]): string[] {
  const e: string[] = [];
  // Present means checked, null included; only spec_review may be null (= no review).
  const has = (k: string) => present.includes(k) && (t as any)[k] !== undefined && !(k === 'spec_review' && (t as any)[k] === null);
  const s = (v: unknown) => String(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 40);
  if (has('spec_state') && !(SPEC_STATES as readonly unknown[]).includes(t.spec_state)) e.push(`bad spec_state "${s(t.spec_state)}" (want ${SPEC_STATES.join('|')})`);
  if (has('blocked_by') && !(typeof t.blocked_by === 'string' && ACTOR_RE.test(t.blocked_by))) e.push(`bad blocked_by "${s(t.blocked_by)}"`);
  if (has('blocked_at') && !isServerTime(t.blocked_at)) e.push(`bad blocked_at "${s(t.blocked_at)}" (want YYYY-MM-DDTHH:mm:ss±HH:MM)`);
  if (has('block_note')) { const ne = blockNoteError(t.block_note); if (ne) e.push(ne); } // cleared = undefined, never ''
  const bsv = t.blocked_spec_version;
  if (has('blocked_spec_version') && !(typeof bsv === 'number' && Number.isSafeInteger(bsv) && bsv >= 0)) e.push('blocked_spec_version must be an integer ≥ 0');
  const r = t.spec_review as any;
  if (has('spec_review')) {
    const keys = ['spec_version', 'by', 'family', 'verdict', 'at'];
    if (typeof r !== 'object' || Array.isArray(r)) e.push('spec_review must be null or a mapping {spec_version, by, family, verdict, at}');
    else {
      const extra = Object.keys(r).filter((k) => !keys.includes(k)), missing = keys.filter((k) => !(k in r));
      if (extra.length || missing.length) e.push(`spec_review: ${[...missing.map((k) => `missing ${k}`), ...extra.map((k) => `unknown ${k}`)].join(', ')}`);
      if ('spec_version' in r && !(typeof r.spec_version === 'number' && Number.isSafeInteger(r.spec_version) && r.spec_version > 0)) e.push('spec_review.spec_version must be a positive integer');
      if ('by' in r && !(typeof r.by === 'string' && ACTOR_RE.test(r.by))) e.push('spec_review.by must be an actor');
      if ('family' in r && !isFamily(r.family)) e.push('spec_review.family must be a family name (lowercase letters, digits, -)');
      if ('verdict' in r && !(VERDICTS as readonly unknown[]).includes(r.verdict)) e.push(`spec_review.verdict must be ${VERDICTS.join('|')}`);
      if ('at' in r && !isServerTime(r.at)) e.push('spec_review.at must be YYYY-MM-DDTHH:mm:ss±HH:MM');
    }
  }
  return e;
}

export function check(b: Board): CheckResult {
  const errors: Issue[] = [...b.loadErrors];
  const warnings: Issue[] = [];
  const err = (file: string, message: string) => errors.push({ file, message });

  // North star
  const nsFile = 'data/northstar.yaml';
  if (b.northstar) {
    if (b.northstar.id !== NORTHSTAR_ID) err(nsFile, `id must be "${NORTHSTAR_ID}"`);
    for (const k of ['title', 'why', 'horizon'] as const) if (!b.northstar[k].trim()) err(nsFile, `${k} is empty`);
  }

  // Goals: exactly one per configured project, any other goal under the north star, ids unique, milestones valid.
  const ids = new Map<string, string>(); // node id -> file
  const milestones = new Map<string, string>(); // milestone id -> goal id
  if (b.northstar) ids.set(b.northstar.id, nsFile);
  const goalCount = new Map<string, number>();
  for (const g of b.goals) {
    const expect = path.basename(g.file, '.yaml');
    if (!GOAL_ID_RE.test(g.id)) err(g.file, `bad goal id "${g.id}"`);
    if (g.id !== expect) err(g.file, `goal id "${g.id}" must match file name "${expect}"`);
    if (g.parent !== NORTHSTAR_ID) err(g.file, `parent must be "${NORTHSTAR_ID}"`);
    if (!g.title.trim()) err(g.file, 'title is empty');
    for (const n of [g, ...g.milestones]) for (const k of ['title_ko', 'title_en'] as const) {
      const v = n[k];
      if (v !== undefined && (v.length > MAX_TITLE_LEN || /[\r\n]/.test(v))) err(g.file, `${n.id}: ${k} must be one line of at most ${MAX_TITLE_LEN} characters`);
    }
    if (!g.owner.trim()) err(g.file, 'owner is empty');
    if (g.profile !== undefined) try { cleanStoredProfile(g.profile); } catch (e: any) { err(g.file, e.message); }
    goalCount.set(g.id, (goalCount.get(g.id) ?? 0) + 1);
    if (ids.has(g.id)) err(g.file, `duplicate id "${g.id}" (also in ${ids.get(g.id)})`);
    ids.set(g.id, g.file);
    for (const m of g.milestones) {
      const mm = MILESTONE_ID_RE.exec(m.id);
      if (!mm) err(g.file, `bad milestone id "${m.id}" (want <goal>.m<slug>)`);
      else if (mm[1] !== g.id) err(g.file, `milestone "${m.id}" must start with "${g.id}."`);
      if (ids.has(m.id)) err(g.file, `duplicate id "${m.id}" (also in ${ids.get(m.id)})`);
      ids.set(m.id, g.file);
      milestones.set(m.id, g.id);
      if (!m.title.trim()) err(g.file, `milestone ${m.id}: title is empty`);
      if (!(MILESTONE_STATUSES as readonly string[]).includes(m.status)) err(g.file, `milestone ${m.id}: bad status "${m.status}"`);
      if (m.due && !isValidDate(m.due)) err(g.file, `milestone ${m.id}: bad due "${m.due}" (YYYY-MM-DD or empty)`);
      if (!Array.isArray(m.done_criteria)) err(g.file, `milestone ${m.id}: done_criteria must be a list`);
    }
  }
  for (const app of REQUIRED_GOAL_IDS) {
    const n = goalCount.get(app) ?? 0;
    if (n !== 1) err(`data/goals/${app}.yaml`, `expected exactly one goal for app "${app}", found ${n}`);
  }
  const goals = new Set(b.goals.filter((g) => GOAL_ID_RE.test(g.id) && g.parent === NORTHSTAR_ID).map((g) => g.id));

  // Tasks
  for (const t of b.tasks) {
    for (const m of checkTask(t, { milestones, goals })) err(t.file, m);
    if (t.id) {
      if (ids.has(t.id)) err(t.file, `duplicate id "${t.id}" (also in ${ids.get(t.id)})`);
      ids.set(t.id, t.file);
    }
    if (t.bytes > MAX_TASK_BYTES) warnings.push({ file: t.file, message: `file is ${t.bytes} B (keep under ${MAX_TASK_BYTES} B)` });
    // A doing card that waits on the user is not being worked: it belongs in blocked-on-user (or needs_user cleared).
    if (t.status === 'doing' && t.needs_user?.trim()) warnings.push({ file: t.file, message: 'doing with needs_user set: move it to blocked-on-user, or clear needs_user' });
  }

  // Links
  b.links.forEach((l, i) => {
    const where = `data/links.yaml[${i}]`;
    if (!ids.has(l.from)) err(where, `dangling link: unknown "from" id "${l.from}"`);
    if (!ids.has(l.to)) err(where, `dangling link: unknown "to" id "${l.to}"`);
    if (l.from && l.from === l.to) err(where, 'link points to itself');
    if (!(LINK_TYPES as readonly string[]).includes(l.type)) err(where, `bad link type "${l.type}"`);
  });

  return { errors, warnings };
}

export function formatIssues(r: CheckResult): string {
  const lines: string[] = [];
  for (const e of r.errors) lines.push(`ERROR ${e.file}: ${e.message}`);
  for (const w of r.warnings) lines.push(`warn  ${w.file}: ${w.message}`);
  return lines.join('\n');
}

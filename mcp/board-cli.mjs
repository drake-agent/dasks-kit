#!/usr/bin/env node
// dasks (alias: gb): the Dasks board CLI, the same HTTP API as the dasks MCP. Zero dependencies.
// Connection: src/lib/connection.mjs. DASKS_ACTOR defaults to <tool>@<machine>.
// DASKS_PROG (set by the `dasks` wrapper) only changes the name shown in help and errors.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { BoardError, client, envActor, machineName, IDEA_STATUSES, LESSON_STATUSES, STRUCTURES } from './board-client.mjs';

const PROG = /^(gb|dasks)$/.test(process.env.DASKS_PROG || '') ? process.env.DASKS_PROG : 'dasks';

const USAGE = `%P — Dasks board CLI (alias: gb).
  %P goals                                   goals + milestones + progress
  %P tasks [--app A] [--status S[,S]] [--owner O] [--mine] [--q TEXT] [--lane L]
  %P show <id>                               task with body and activity
  %P new <app> "<title>" [--title-ko ..] [--title-en ..] [--milestone M] [--body TEXT] [--kind K] [--priority P]
                 [--lane L] [--status S] [--deps id,id] [--secrets label,label] app = any goal id (%P goals), e.g. demo
  %P update <id> [--status S] [--note TEXT] [--what ..] [--why ..] [--do ..] [--rec ..] [--after ..]
                 [--pr URL] [--pr-summary ..] [--needs-user ..] [--title ..] [--title-ko ..] [--title-en ..] [--deps id,id|""] [--secrets label,label|""] [--version N]
  %P stuck                                stuck reasons, ages and top blockers (read-only)
  %P ready [--app A] [--limit N] [--all]     spec-ready todo tasks: the user's pushes first (★), then most-unblocking
                                             (depends_on); --all also lists cards whose spec is not ready
  %P intake [--app A]                       todo counts by goal, creator, id family and spec state (read-only)
  %P claim <id> [--who NAME] [--force] [--note TEXT] [--version N]
  %P finish <id> --result TEXT [--pr URL] [--pr-summary ..] [--status done|review|blocked-on-user] [--what ..] …
  %P release <id> [--force]
  %P views                                   project pages and their view versions
  %P view <app>                              one project's view config (JSON); page: <board>/p/<app>
  %P view set <app> <file|->                 replace it (JSON {title?, tagline?, structure?, widgets}); a "version"
                                             in the file, or --version N, makes it fail if someone changed it since
  %P structure <app> kanban|threads|list|tree [--version N]   how the page lays out its tasks
  %P profile <app>                           the project's why and profile: what works today, what is missing
  %P profile set <app> <file|->              replace it from JSON {profile: {features, gaps} | null, why?, title?,
                                             title_ko?, title_en?}; the board stamps as_of and by
  %P ideas [app] [--status open|promoted|dropped]  "Ideas for later" (counts, or one project's list)
  %P idea add <app> "<title>" [--note ..] [--source ..] [--title-ko ..] [--title-en ..] [--note-ko ..] [--note-en ..]
  %P idea update <id> [--status open|dropped] [--title ..] [--note ..] [--title-ko ..] … [--version N]
  %P idea promote <id> [--milestone M] [--kind K] [--priority P] [--lane L] [--title ..] [--version N]
  %P lessons [app] [--status proposed|confirmed|retired] [--files a,b] [--limit N]   lessons from earlier cards
  %P lesson add <app> "<text>" [--task ID] [--files a,b]   one lesson (agents: a proposal; only the user confirms)
  %P lesson update <id> [--text ..] [--files a,b] [--status proposed|confirmed|retired] [--version N]
  %P i18n fill [--dry-run] [--app A] [--batch N]   add missing title_ko/title_en (and idea note_ko/note_en) with
                                             claude -p, written through the API as dasks-i18n
  %P fleet                                   machines in the fleet: last heartbeat, busy/idle/quiet, cards, kit
                                             version (BEHIND = older than the board's kit) and why a self-update held
  %P backup status | now                     the board data backup (backup.remote): last push, failures; now = push now
  %P summary                                 the latest daily summary (written at summary.at each day)
  %P machine add <name> | list | revoke <name>   machine tokens for a fleet (run on the board's Mac; add prints
                                             the token once: give it to that Mac's install.sh --join)
  %P captain                                 who holds the captain lease, the harness chain
  %P captain chat read [--since N]           captain chat messages after N
  %P captain chat reply "<text>"             write in the captain chat (only the lease holder, with its
                                             DASKS_CAPTAIN_LEASE; as captain@<machine>)
Options: --json (raw output). review/blocked-on-user need --what --why --do --rec --after (and --pr-summary with a PR).
--title-ko / --title-en are optional per-language display titles.
Env: DASKS_URL, DASKS_ACTOR (now: %ACTOR%)`;

function defaultActor() {
  const tool = process.env.CLAUDECODE ? 'claude-code' : (process.env.CODEX_SANDBOX || process.env.CODEX_THREAD_ID || process.env.CODEX_HOME) ? 'codex' : 'cli';
  return `${tool}@${machineName()}`;
}

const BOOL = ['json', 'force', 'mine', 'help', 'dry-run', 'all'];

function parse(argv) {
  const pos = []; const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (BOOL.includes(k)) {
        if (v === undefined || v === 'true' || v === '1') opt[k] = true;
        else if (v === 'false' || v === '0') delete opt[k];
        else die(`--${k} takes no value (or =true/=false)`);
      } else if (v !== undefined) opt[k] = v;
      else { if (i + 1 >= argv.length) die(`--${k} needs a value`); opt[k] = argv[++i]; }
    } else pos.push(a);
  }
  return { pos, opt };
}

function die(msg, code = 2) { process.stderr.write(`${PROG}: ${msg}\n`); process.exit(code); }

function parseVersion(value) {
  if (!/^\d+$/.test(value)) die('--version must be a number');
  return Number(value);
}

function checkStatuses(status, allowed) {
  if (status && !String(status).split(',').every((s) => allowed.includes(s))) die(`--status must be ${allowed.join('|')}`);
}

const pick = (opt, map) => {
  const o = {};
  for (const [flag, key] of Object.entries(map)) if (opt[flag] !== undefined) o[key] = opt[flag];
  if (opt.version !== undefined) o.expected_version = parseVersion(opt.version);
  return o;
};
const CTX = { what: 'what', why: 'why', do: 'do', rec: 'rec', after: 'after', 'pr-summary': 'pr_summary', pr: 'pr', note: 'note' };
const TITLES = { 'title-ko': 'title_ko', 'title-en': 'title_en' };
const IDEA_FLAGS = { title: 'title', note: 'note', source: 'source', 'note-ko': 'note_ko', 'note-en': 'note_en', ...TITLES };
const lessonLine = (l) => `${l.status.padEnd(9)} ${l.id}  ${l.text}\n            by ${l.added_by}${l.task ? ` on ${l.task}` : ''}${l.files?.length ? ` · ${l.files.join(', ')}` : ''}`;
const ideaLine = (i) => `${i.status.padEnd(9)} ${i.id}${i.promoted_task_id ? ` -> ${i.promoted_task_id}` : ''}  ${i.title}${i.note ? `\n            ${i.note}` : ''}`;

function line(t) {
  const claim = t.claimed_by ? ` [${t.claimed_by}]` : '';
  return `${t.status.padEnd(15)} ${t.priority} ${t.id}${claim}  ${t.title}`;
}

function printTask(t) {
  const out = [`${t.id}  (v${t.version ?? 0})`, `  ${t.title}`, `  status ${t.status} · owner ${t.owner} · lane ${t.lane} · ${t.kind} · ${t.priority}`];
  if (t.claimed_by) out.push(`  claimed by ${t.claimed_by} at ${t.claimed_at}`);
  if (t.depends_on) out.push(`  depends on: ${t.depends_on}`);
  if (t.secrets) out.push(`  needs keys: ${t.secrets} (dasks-secret run --labels ${t.secrets.split(/[\s,]+/).filter(Boolean).join(',')} -- …)`);
  if (t.pr) out.push(`  PR ${t.pr}`);
  if (t.needs_user) out.push(`  needs you: ${t.needs_user}`);
  if (t.result) out.push(`  result: ${t.result.split('\n')[0]}`);
  if (t.body?.trim()) out.push('', t.body.trim());
  if (t.activity?.length) out.push('', 'Activity:', ...t.activity.slice(-10).map((a) => `  ${a.at.slice(5, 16).replace('T', ' ')} ${a.actor} ${a.action}${a.from || a.to ? ` ${a.from || '·'} -> ${a.to || '·'}` : ''}${a.note ? ` — ${a.note}` : ''}`));
  if (t.lessons?.length) out.push('', 'Lessons from earlier cards:', ...t.lessons.map((l) => `  ${l.status === 'confirmed' ? '✓' : '?'} ${l.text}${l.files?.length ? ` (${l.files.join(', ')})` : ''}`));
  if (t.warnings?.length) out.push('', ...t.warnings.map((w) => `warning: ${w}`));
  return out.join('\n');
}

async function main() {
  const { pos, opt } = parse(process.argv.slice(2));
  const actor = envActor() || defaultActor();
  const [cmd, ...args] = pos;
  if (!cmd || opt.help || cmd === 'help') {
    // Columns are laid out for a two-letter program name; a longer one eats into the gap so descriptions stay aligned.
    const cut = PROG.length - 2;
    const fit = (l) => l.replace(/^(\s+%P .*?\S)( {2,})(\S)/, (_, a, sp, c) => a + sp.slice(Math.min(cut, sp.length - 1)) + c);
    console.log(USAGE.split('\n').map(fit).join('\n').replaceAll('%P', PROG).replace('%ACTOR%', actor));
    return;
  }
  const board = client({ actor });
  const show = (r, fmt) => console.log(opt.json ? JSON.stringify(r, null, 1) : fmt(r));
  const need = (n, what) => { if (args.length < n) die(`usage: ${PROG} ${cmd} ${what}`); };

  switch (cmd) {
    case 'goals':
      return show(await board.goals(), (r) => r.goals.map((g) => `${g.app.padEnd(7)} ${String(g.pct).padStart(3)}%  ${g.title}${g.repo ? `  ${g.repo}` : ''}\n${g.milestones.map((m) => `   ${m.id.padEnd(28)} ${m.status.padEnd(8)} ${String(m.pct).padStart(3)}%  ${m.title}`).join('\n')}`).join('\n'));
    case 'tasks': {
      const f = { app: opt.app, status: opt.status, owner: opt.owner, lane: opt.lane, kind: opt.kind, milestone: opt.milestone, query: opt.q };
      if (opt.mine) f.claimed_by = actor;
      return show(await board.tasks(f), (r) => r.map(line).join('\n') || '(no tasks)');
    }
    case 'stuck':
      return show(await board.stuck(), (r) => [
        `Stuck: ${r.total} (${Object.entries(r.counts).map(([reason, n]) => `${reason} ${n}`).join(', ')})`,
        ...r.items.map((t) => `${t.reason}  ${t.age_hours.toFixed(1)}h  ${t.id}  ${t.title}${t.root_blocker ? `  waits on ${t.root_blocker}` : ''}${t.missing?.length ? `  missing ${t.missing.join(', ')}` : ''}`),
      ].join('\n'));
    case 'ready':
      return show(await board.ready({ app: opt.app, limit: opt.limit, all: opt.all }), (r) => [
        ...(r.ready.length ? r.ready.map((t) => `${String(t.unblocks).padStart(3)} unblocks  ${t.priority} ${t.id}  ${t.title}${t.push_note ? `  ${t.push_note}` : ''}${t.missing_ignored?.length ? `  missing ignored: ${t.missing_ignored.join(', ')}` : ''}`) : ['(nothing ready)']),
        ...(r.blocked.length ? [`blocked (${r.blocked.length}):`, ...r.blocked.map((b) => `  ${b.id} waits on ${[...b.waiting_on, ...b.missing.map((m) => m + '(missing)'), ...(b.cancelled ?? []).map((c) => c + '(cancelled: relink or drop)')].join(', ')}`)] : []),
        ...(r.cycles.length ? [`CYCLES: ${r.cycles.join(' | ')}`] : []),
      ].join('\n'));
    case 'intake':
      return show(await board.intake({ app: opt.app }), (r) => {
        const group = (name, o) => { const e = Object.entries(o).slice(0, 15); const w = Math.max(0, ...e.map(([k]) => k.length)); return [`${name}:`, ...e.map(([k, n]) => `  ${k.padEnd(w)}  ${String(n).padStart(4)}`)]; };
        return [`todo ${r.total} · created in the last 24 h ${r.created_last_24h}`, ...group('by goal', r.by_goal), ...group('by creator', r.by_creator), ...group('by id family', r.by_id_family), ...group('by spec state', r.by_spec_state)].join('\n');
      });
    case 'show': need(1, '<id>'); return show(await board.task(args[0]), printTask);
    case 'new': {
      need(2, '<app> "<title>"');
      const f = { goal: args[0], title: args.slice(1).join(' '), ...pick(opt, { milestone: 'milestone', body: 'body', kind: 'kind', priority: 'priority', lane: 'lane', status: 'status', 'needs-user': 'needs_user', deps: 'depends_on', secrets: 'secrets', ...TITLES, ...CTX }) };
      delete f.note;
      // Over the goal's todo limit the board keeps the card as an idea (202): say so instead of printing a task.
      return show(await board.create(f), (r) => (r.intake === 'idea'
        ? `not created: ${r.goal} has ${r.open_todo} todo (limit ${r.limit}); kept as idea ${r.idea.id} (promote it when there is room: ${PROG} idea promote ${r.idea.id})`
        : printTask(r)));
    }
    case 'update': need(1, '<id> [--status S] [--note TEXT] …'); return show(await board.update(args[0], pick(opt, { status: 'status', title: 'title', ...TITLES, 'needs-user': 'needs_user', priority: 'priority', result: 'result', deps: 'depends_on', secrets: 'secrets', ...CTX })), printTask);
    case 'claim': need(1, '<id>'); return show(await board.claim(args[0], { ...pick(opt, { who: 'who', note: 'note' }), ...(opt.force ? { force: true } : {}) }), printTask);
    case 'release': need(1, '<id>'); return show(await board.release(args[0], { ...pick(opt, { note: 'note' }), ...(opt.force ? { force: true } : {}) }), printTask);
    case 'finish':
      need(1, '<id> --result TEXT');
      if (!opt.result) die('finish needs --result');
      return show(await board.finish(args[0], { ...pick(opt, { result: 'result', status: 'status', ...CTX }), ...(opt.force ? { force: true } : {}) }), printTask);
    case 'views':
      return show(await board.views(), (r) => r.map((v) => `${v.app.padEnd(7)} ${v.default ? 'default' : `v${v.version}`.padEnd(7)} ${v.url}${v.updated_by ? `  (${v.updated_by} ${v.updated.slice(0, 16).replace('T', ' ')})` : ''}${v.error ? `  ERROR ${v.error}` : ''}`).join('\n'));
    case 'view': {
      if (args[0] === 'set') {
        if (args.length < 3) die(`usage: ${PROG} view set <app> <file|->`);
        const [, app, file] = args;
        let text;
        try { text = fs.readFileSync(file === '-' ? 0 : file, 'utf8'); } catch (e) { die(`cannot read ${file}: ${e.message}`); }
        let view;
        try { view = JSON.parse(text); } catch (e) { die(`${file} is not JSON: ${e.message}`); }
        if (!view || typeof view !== 'object' || Array.isArray(view)) die(`${file} must hold a JSON object {title?, tagline?, widgets}`);
        let ev;
        if (opt.version !== undefined) ev = parseVersion(opt.version);
        else if (Number.isInteger(view.version)) ev = view.version;
        const r = await board.setView(app, view, ev);
        return show(r, (v) => `${v.app} view v${v.version} saved by ${v.updated_by} · ${v.widgets.length} widgets: ${v.widgets.map((w) => w.type).join(' ')}\npage: ${board.url}${v.url}`);
      }
      need(1, '<app> | set <app> <file|->');
      // The config is JSON either way; --json only adds the recent activity.
      const r = await board.view(args[0]);
      if (!opt.json) { delete r.activity; }
      return console.log(JSON.stringify(r, null, 2));
    }
    case 'profile': {
      if (args[0] === 'set') {
        if (args.length < 3) die(`usage: ${PROG} profile set <app> <file|->`);
        const [, app, file] = args;
        let body;
        try { body = JSON.parse(fs.readFileSync(file === '-' ? 0 : file, 'utf8')); } catch (e) { die(`cannot read ${file} as JSON: ${e.message}`); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || !('profile' in body)) die(`${file} must hold {profile: {features, gaps} | null, why?, title?, title_ko?, title_en?}`);
        const { profile, why, title, title_ko, title_en } = body;
        await board.setProfile(app, { profile, why, title, title_ko, title_en });
        return show(await board.profile(app), (p) => `${p.app} profile ${p.profile ? `${p.profile.features.length} feature(s), ${p.profile.gaps.length} gap(s) (${p.profile.by} ${String(p.profile.as_of).slice(0, 16).replace('T', ' ')})` : 'removed'}\npage: ${board.url}/p/${p.app}`);
      }
      need(1, '<app> | set <app> <file|->');
      return console.log(JSON.stringify(await board.profile(args[0]), null, 2));
    }
    case 'structure': {
      if (args.length < 2 || !STRUCTURES.includes(args[1])) die(`usage: ${PROG} structure <app> ${STRUCTURES.join('|')} [--version N]`);
      const ev = pick(opt, {}).expected_version;
      return show(await board.setStructure(args[0], args[1], ev), (v) => `${v.app} structure ${v.structure} (view v${v.version}, ${v.updated_by})\npage: ${board.url}${v.url}`);
    }
    case 'ideas': {
      checkStatuses(opt.status, IDEA_STATUSES);
      if (!args[0]) return show(await board.ideaSummaries(), (r) => r.map((x) => `${x.app.padEnd(7)} ${String(x.open).padStart(3)} open  ${String(x.promoted).padStart(3)} promoted  ${String(x.dropped).padStart(3)} dropped${x.error ? `  ERROR ${x.error}` : ''}`).join('\n'));
      return show(await board.ideas(args[0], opt.status), (r) => r.ideas.map(ideaLine).join('\n') || '(no ideas)');
    }
    case 'idea': {
      const [sub, a1, ...rest] = args;
      if (sub === 'add') {
        if (!a1 || !rest.length) die(`usage: ${PROG} idea add <app> "<title>" [--note ..] [--source ..]`);
        const f = { title: rest.join(' '), ...pick(opt, IDEA_FLAGS) };
        delete f.expected_version;
        return show(await board.addIdea(a1, f), ideaLine);
      }
      if (sub === 'update') {
        if (!a1) die(`usage: ${PROG} idea update <id> [--status open|dropped] [--note ..] …`);
        return show(await board.updateIdea(a1, pick(opt, { ...IDEA_FLAGS, status: 'status' })), ideaLine);
      }
      if (sub === 'promote') {
        if (!a1) die(`usage: ${PROG} idea promote <id> [--milestone M] …`);
        const r = await board.promoteIdea(a1, pick(opt, { title: 'title', ...TITLES, milestone: 'milestone', kind: 'kind', priority: 'priority', lane: 'lane', owner: 'owner' }));
        return show(r, (x) => `${x.idea.id} promoted -> ${x.task.id}\n${printTask(x.task)}`);
      }
      return die(`usage: ${PROG} idea add|update|promote …`);
    }
    case 'lessons': {
      checkStatuses(opt.status, LESSON_STATUSES);
      if (!args[0]) return show(await board.lessonSummaries(), (r) => r.map((x) => `${x.app.padEnd(7)} ${String(x.proposed).padStart(3)} proposed  ${String(x.confirmed).padStart(3)} confirmed  ${String(x.retired).padStart(3)} retired${x.error ? `  ERROR ${x.error}` : ''}`).join('\n'));
      return show(await board.lessons(args[0], { status: opt.status, files: opt.files, limit: opt.limit }), (r) => r.lessons.map(lessonLine).join('\n') || '(no lessons)');
    }
    case 'lesson': {
      const [sub, a1, ...rest] = args;
      const f = pick(opt, { text: 'text', task: 'task', status: 'status' });
      if (opt.files !== undefined) f.files = String(opt.files).split(',').filter(Boolean);
      if (sub === 'add') {
        if (!a1 || !rest.length) die(`usage: ${PROG} lesson add <app> "<text>" [--task ID] [--files a,b]`);
        delete f.expected_version; delete f.status;
        return show(await board.addLesson(a1, { ...f, text: rest.join(' ') }), lessonLine);
      }
      if (sub === 'update') {
        if (!a1) die(`usage: ${PROG} lesson update <id> [--text ..] [--files a,b] [--status S]`);
        delete f.task;
        return show(await board.updateLesson(a1, f), lessonLine);
      }
      return die(`usage: ${PROG} lesson add|update …`);
    }
    case 'fleet':
      return show(await board.fleet(), (r) => (r.machines.length ? r.machines.map((m) => `${m.machine.padEnd(16)} ${m.state.padEnd(5)} last seen ${m.last_seen.slice(0, 19).replace('T', ' ')}  slots ${m.slots}  ${m.harnesses.join(',') || 'no harness'}  ${m.cards.join(' ') || '-'}${m.version ? `  v${m.version}` : ''}${m.behind ? '  BEHIND' : ''}${m.update ? `  (update held: ${m.update})` : ''}`).join('\n') : '(no machine has sent a heartbeat)') + `\n(quiet = no heartbeat for ${r.dead_min} min; its runner's cards go back to the pool; BEHIND = its kit is older than the board's)`);
    case 'backup': {
      const sub = args[0] ?? 'status';
      if (sub !== 'status' && sub !== 'now') throw new Error(`usage: ${PROG} backup status | now`);
      const line = (b) => (!b.remote ? 'backup: off (set backup.remote in config.json; docs/upgrade.md)'
        : [`backup: ${b.state} -> ${b.remote} branch ${b.branch}, every ${b.every_min} min`, `last good push: ${b.last_ok_at ?? 'never'}${b.last_ok_sha ? ` (${b.last_ok_sha.slice(0, 12)})` : ''}`,
          ...(b.failures ? [`failing: ${b.failures} in a row; last error: ${b.last_error}`] : []), ...(b.warning ? [b.warning] : [])].join('\n'));
      if (sub === 'status') return show(await board.backup(), line);
      try { return show(await board.backupNow(), line); }
      catch (e) { if (e instanceof BoardError && e.status === 502 && e.data) { show(e.data, line); process.exitCode = 1; return; } throw e; }
    }
    case 'summary':
      return show(await board.summary(), (r) => (r.summary ? r.summary.text : `no summary yet (the board writes one each day at ${r.at})`));
    case 'machine': {
      const [sub, name] = args;
      if (!['add', 'list', 'revoke'].includes(sub) || (sub !== 'list' && !name)) die(`usage: ${PROG} machine add <name> | list | revoke <name>`);
      const tool = new URL('../bin/dasks-tokens.ts', import.meta.url).pathname;
      const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', tool, 'machine', sub, ...(name ? [name] : [])], { stdio: 'inherit' });
      process.exitCode = r.status ?? 1;
      return;
    }
    case 'captain': {
      const [sub, verb, ...rest] = args;
      if (!sub) return show(await board.captain(), (r) => `captain: ${r.lease ? `${r.lease.holder} (since ${r.lease.since}, lease until ${r.lease.expires_at})` : 'none'}\nharness chain: ${r.harness.join(' -> ')}\nchat: ${r.chat_seq} message(s)`);
      if (sub !== 'chat' || !['read', 'reply'].includes(verb)) die(`usage: ${PROG} captain | captain chat read [--since N] | captain chat reply "<text>"`);
      if (verb === 'read') {
        if (opt.since !== undefined && !/^\d+$/.test(opt.since)) die('--since must be a message number');
        return show(await board.chat(Number(opt.since ?? 0)), (r) => r.messages.map((m) => `#${m.seq} ${m.at.slice(0, 16).replace('T', ' ')} ${m.from}\n    ${m.text.split('\n').join('\n    ')}`).join('\n') || `(no messages after #${opt.since ?? 0}; last #${r.last_seq})`);
      }
      if (!rest.length) die(`usage: ${PROG} captain chat reply "<text>"`);
      const text = rest.join(' ') === '-' ? fs.readFileSync(0, 'utf8') : rest.join(' ');
      const leaseId = process.env.DASKS_CAPTAIN_LEASE;
      if (!leaseId) die('captain chat reply needs the captain lease: run it inside the dasks-captain session (DASKS_CAPTAIN_LEASE)');
      const cap = client({ actor: process.env.DASKS_ACTOR?.startsWith('captain@') ? process.env.DASKS_ACTOR : `captain@${machineName()}` });
      return show(await cap.chatReply(text, leaseId), (m) => `sent #${m.seq} as ${m.from}`);
    }
    case 'i18n': {
      if (args[0] !== 'fill') die(`usage: ${PROG} i18n fill [--dry-run] [--app A] [--batch N]`);
      return i18nFill(opt);
    }
    default: die(`unknown command "${cmd}" (${PROG} help)`);
  }
}

// ---------- i18n fill ----------
// Finds titles (and idea notes) that have no translation in the other language and fills them with short translations
// from `claude -p`, in batches, written through the normal API as "dasks-i18n" (task versions are checked; an item someone
// changed meanwhile is skipped). The original title is never changed. Context fields (what/why/…, pr_summary) are left as written.
const HANGUL = /[가-힣]/;
const KEEP = ['Dasks', 'North Star', 'NorthStar', 'PR #n'];

function i18nCommand() {
  if (process.env.DASKS_I18N_CMD) { try { const c = JSON.parse(process.env.DASKS_I18N_CMD); if (Array.isArray(c) && c.length) return c.map(String); } catch { /* fall through */ } die('DASKS_I18N_CMD must be a JSON list, e.g. ["claude","-p","--model","<model>"]'); }
  return ['claude', '-p'];
}

/** [{key, kind, id, field, text, to}] for everything missing a translation. */
async function missingTranslations(board, onlyApp) {
  const b = await board.board();
  const out = [];
  const want = (kind, id, text, o, app, [ko, en], version) => {
    if (!text || (onlyApp && app !== onlyApp)) return;
    const to = HANGUL.test(text) ? 'en' : 'ko';
    const field = to === 'en' ? en : ko;
    if (!o[field]) out.push({ key: `k${out.length}`, kind, id, field, text, to, version });
  };
  const T = ['title_ko', 'title_en'];
  if (b.northstar) want('node', b.northstar.id, b.northstar.title, b.northstar, b.northstar.id, T);
  for (const g of b.goals) {
    want('node', g.id, g.title, g, g.id, T);
    for (const m of g.milestones) want('node', m.id, m.title, m, g.id, T);
  }
  for (const t of b.tasks) if (t.status !== 'cancelled') want('task', t.id, t.title, t, t.goal, T, t.version ?? 0);
  for (const g of b.goals) {
    if (onlyApp && g.id !== onlyApp) continue;
    let f;
    try { f = await board.ideas(g.id); } catch { continue; }
    for (const i of f.ideas) {
      if (i.status === 'dropped') continue;
      want('idea', i.id, i.title, i, g.id, T, i.version);
      want('idea', i.id, i.note, i, g.id, ['note_ko', 'note_en'], i.version);
    }
  }
  return out;
}

function translateBatch(cmd, items) {
  const list = items.map((x) => ({ k: x.key, to: x.to === 'en' ? 'English' : 'Korean', text: x.text }));
  const prompt = [
    'Translate each item for a task board. Rules:',
    '- Titles: a short title in the target language, one line, plain words, no trailing period. Notes: one or two plain sentences.',
    `- Keep these proper nouns exactly as written: ${KEEP.join(', ')}, product and repo names, PR numbers (PR #12), ids, version numbers, code names in backticks.`,
    '- Titles are noun phrases, not sentences. English: sentence case.',
    '- Do not add or drop meaning. Do not explain.',
    'Reply with ONLY one JSON object mapping each k to its translation, e.g. {"k0":"...","k1":"..."}.',
    '', JSON.stringify(list),
  ].join('\n');
  const r = spawnSync(cmd[0], [...cmd.slice(1), prompt], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`translator failed (${r.error?.message || `exit ${r.status}`}): ${(r.stderr || '').slice(-300)}`);
  const m = /\{[\s\S]*\}/.exec(r.stdout || '');
  if (!m) throw new Error(`translator gave no JSON: ${(r.stdout || '').slice(0, 200)}`);
  const o = JSON.parse(m[0]);
  const out = {};
  for (const x of items) {
    const v = typeof o[x.key] === 'string' ? o[x.key].replace(/\s+/g, ' ').trim() : '';
    // A Korean target must contain Hangul; an English one must not be the Korean text echoed back.
    if (v && v.length <= (x.field.startsWith('note') ? 600 : 120) && (x.to === 'ko' ? HANGUL.test(v) : !HANGUL.test(v))) out[x.key] = v;
  }
  return out;
}

async function i18nFill(opt) {
  const actor = process.env.DASKS_I18N_ACTOR || 'dasks-i18n';
  const board = client({ actor });
  const items = await missingTranslations(board, opt.app);
  const count = (xs) => Object.entries(xs.reduce((a, x) => { const k = `${x.kind}.${x.field}`; a[k] = (a[k] || 0) + 1; return a; }, {})).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing';
  console.log(`missing: ${items.length} (${count(items)})`);
  if (opt['dry-run'] || !items.length) {
    if (opt['dry-run']) for (const x of items.slice(0, 40)) console.log(`  ${x.kind.padEnd(4)} ${x.id} ${x.field}: ${x.text.slice(0, 70)}`);
    if (opt['dry-run'] && items.length > 40) console.log(`  … ${items.length - 40} more`);
    return;
  }
  const size = Math.max(5, Math.min(80, Number(opt.batch) || 40));
  const cmd = i18nCommand();
  const done = []; const skipped = []; const failed = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    let tr;
    try { tr = translateBatch(cmd, batch); } catch (e) { failed.push(...batch.map((x) => `${x.id} ${x.field}: ${e.message.slice(0, 120)}`)); continue; }
    // One write per item (ideas: title and note of one idea go together).
    const byTarget = new Map();
    for (const x of batch) {
      if (!tr[x.key]) { skipped.push(`${x.id} ${x.field}: no usable translation`); continue; }
      const k = `${x.kind}:${x.id}`;
      if (!byTarget.has(k)) byTarget.set(k, { x, fields: {} });
      byTarget.get(k).fields[x.field] = tr[x.key];
    }
    for (const { x, fields } of byTarget.values()) {
      try {
        let r;
        if (x.kind === 'task') r = await board.update(x.id, { ...fields, expected_version: x.version });
        else if (x.kind === 'idea') r = await board.updateIdea(x.id, { ...fields, expected_version: x.version });
        // Nodes have no version: only if the title is still the one translated and the field is still empty.
        else await board.updateNode(x.id, { ...fields, expected_title: x.text, if_missing: true });
        // The same idea can come back in the next batch (its note): carry the new version over.
        if (r?.version !== undefined) for (const y of items) if (y.kind === x.kind && y.id === x.id) y.version = r.version;
        done.push(...Object.keys(fields).map((f) => `${x.kind}.${f}`));
      } catch (e) {
        (e instanceof BoardError && e.status === 409 ? skipped : failed).push(`${x.id}: ${e.message.slice(0, 160)}`);
      }
    }
    console.log(`batch ${i / size + 1}/${Math.ceil(items.length / size)}: ${done.length} written so far`);
  }
  const tally = done.reduce((a, k) => { a[k] = (a[k] || 0) + 1; return a; }, {});
  console.log(`written: ${done.length} (${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}) · skipped: ${skipped.length} · failed: ${failed.length}`);
  for (const s of [...skipped, ...failed].slice(0, 30)) console.log(`  ${s}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  if (e instanceof BoardError) die(typeof e.data === 'object' ? `${e.status}: ${JSON.stringify(e.data)}` : e.message, 1);
  die(e.message, 1);
});

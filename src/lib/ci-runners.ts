// dasks-ci: self-hosted GitHub Actions runners on your Macs (docs/ci-runners.md). Pure parts and the shell scripts that
// run on a host; src/cli/ci.ts drives them locally or over ssh.
import crypto from 'node:crypto';

export const PLAN_DEFAULTS = { cpu_per_job: 2, ram_per_job_gb: 3, reserve_gb: 4 };
export type PlanOptions = typeof PLAN_DEFAULTS;
export type HostFacts = { arch: string; cores: number; ram_gb: number };

/** Jobs this Mac can run at once: the smaller of what its cores and its RAM (after the reserve) allow, at least 1. */
export function planJobs(f: Pick<HostFacts, 'cores' | 'ram_gb'>, o: PlanOptions = PLAN_DEFAULTS) {
  const by_cpu = Math.floor(f.cores / o.cpu_per_job);
  const by_ram = Math.floor((f.ram_gb - o.reserve_gb) / o.ram_per_job_gb);
  return { by_cpu, by_ram, jobs: Math.max(1, Math.min(by_cpu, by_ram)) };
}

/** `uname -m` + `sysctl -n hw.ncpu hw.memsize` → facts. */
export function parseFacts(arch: string, sysctl: string): HostFacts {
  const [ncpu, mem] = sysctl.trim().split(/\s+/).map(Number);
  if (!(ncpu > 0) || !(mem > 0)) throw new Error(`could not read cores and RAM from sysctl (got "${sysctl.trim()}")`);
  return { arch: arch.trim(), cores: ncpu, ram_gb: Math.floor(mem / 2 ** 30) };
}

/** The runner package arch for `uname -m`. */
export function runnerArch(uname: string): 'arm64' | 'x64' {
  if (uname === 'arm64') return 'arm64';
  if (uname === 'x86_64') return 'x64';
  throw new Error(`unsupported Mac architecture ${uname}`);
}

type Release = { tag_name?: string; body?: string; assets?: { id: number; name: string; digest?: string | null }[] };

/** The macOS tarball of an actions/runner release and its published SHA-256 (the release notes, else the asset digest). */
export function releaseAsset(rel: Release, arch: 'arm64' | 'x64') {
  const asset = (rel.assets ?? []).find((a) => new RegExp(`^actions-runner-osx-${arch}-[0-9.]+\\.tar\\.gz$`).test(a.name));
  if (!asset) throw new Error(`release ${rel.tag_name ?? '?'} has no osx-${arch} tarball`);
  const m = (rel.body ?? '').match(new RegExp(`<!-- BEGIN SHA osx-${arch} -->\\s*([0-9a-f]{64})\\s*<!-- END SHA osx-${arch} -->`));
  const d = asset.digest?.match(/^sha256:([0-9a-f]{64})$/);
  const sha = m?.[1] ?? d?.[1];
  if (!sha) throw new Error(`release ${rel.tag_name ?? '?'} publishes no SHA-256 for ${asset.name}; not downloading it`);
  return { id: asset.id, name: asset.name, sha };
}

/** A name part GitHub and the file system both take. */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'mac';
}

/** `<host>-<owner>-<repo>-<n>`. GitHub takes 64 characters: a longer base is cut and ends in a hash of the repo. */
export function runnerNames(host: string, repo: string, count: number): string[] {
  const [owner, name] = repo.split('/');
  let base = `${slug(host)}-${slug(owner)}-${slug(name ?? '')}`;
  if (base.length > 56) base = `${base.slice(0, 49).replace(/-+$/, '')}-${crypto.createHash('sha256').update(repo.toLowerCase()).digest('hex').slice(0, 6)}`;
  return Array.from({ length: count }, (_, i) => `${base}-${i + 1}`);
}

export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const LABEL_RE = /^[A-Za-z0-9_.-]+$/;
export const NAME_RE = /^[a-z0-9-]+$/;

/** One argument for a POSIX shell. */
export function shq(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/** The command line ssh hands the remote login shell: the script travels base64 in argv, stdin stays free for a token. */
export function remoteCommand(script: string, args: string[]): string {
  const b64 = Buffer.from(script).toString('base64');
  return `env -u SHELLOPTS -u BASH_ENV -u ENV bash --noprofile --norc -c "$(printf %s ${b64} | base64 --decode)" dasks-ci ${args.map(shq).join(' ')}`.trimEnd();
}

// ---------- scripts that run on the host (bash, as the logged-in user) ----------

// Every host script starts with tracing off (a trace would print the token) and no shell options for its children.
// Runners live in the user's login session, gui/<uid>. From an ssh session launchctl's default is that session's own
// domain, which launchd ends soon after ssh disconnects, so every launchctl call names gui/<uid>.
const DIRS = `set +xv; unset SHELLOPTS BASH_ENV ENV 2>/dev/null; R="$HOME/.dasks/ci-runners"; S="$HOME/.dasks/ci-slots"
uid=$(id -u); gui_ok() { launchctl print "gui/$uid" >/dev/null 2>&1; }
label_of() { basename "$(cat "$1/.service" 2>/dev/null)" .plist; }`;

/** Read-only: arch, cores and RAM, the runner dirs, and the SHA-256 of a cached tarball ($1, optional). */
export const SURVEY = `${DIRS}
printf 'facts\\t%s\\t%s\\n' "$(uname -m)" "$(sysctl -n hw.ncpu hw.memsize | tr '\\n' ' ')"
for d in "$R"/*/; do
  [ -d "$d" ] || continue
  n=$(basename "$d"); st=partial; [ -f "$d.runner" ] && st=configured
  printf 'dir\\t%s\\t%s\\t%s\\n' "$n" "$st" "$(cat "$d.dasks-repo" 2>/dev/null)"
done
if [ -n "\${1:-}" ] && [ -f "$R/.cache/$1" ]; then printf 'cache\\t%s\\n' "$(shasum -a 256 "$R/.cache/$1" | cut -d' ' -f1)"; fi
[ -s "$S/max" ] && printf 'max\\t%s\\n' "$(cat "$S/max")"
if gui_ok; then printf 'gui\\tok\\n'; else printf 'gui\\tmissing\\n'; fi
exit 0
`;

/**
 * The job hook (\`job-hook.sh started|completed\`): one of \`max\` machine-wide slots per running job. A slot is a file
 * slot.<pid> for the job's Runner.Worker, taken and swept under a mkdir lock; a slot whose Worker is gone is stale and
 * freed. A job that waits past wait_sec runs anyway. The hook never fails a job.
 */
export const HOOK = `#!/bin/bash
D="$HOME/.dasks/ci-slots"
mkdir -p "$D"
log() { echo "dasks-ci slot: $*" >&2; echo "$(date '+%Y-%m-%dT%H:%M:%S') \${RUNNER_NAME:-?} $*" >> "$D/hook.log"; }
max=$(cat "$D/max" 2>/dev/null); case $max in ''|*[!0-9]*) max=1 ;; esac; [ "$max" -ge 1 ] || max=1
wait_sec=\${DASKS_CI_SLOT_WAIT_SEC:-$(cat "$D/wait_sec" 2>/dev/null)}; case $wait_sec in ''|*[!0-9]*) wait_sec=1800 ;; esac
poll=\${DASKS_CI_SLOT_POLL_SEC:-5}

cmd_of() { ps -o command= -p "$1" 2>/dev/null; }
# The job's Runner.Worker among this hook's parents; the parent itself when there is none.
worker() {
  local p=$$ c
  while [ "\${p:-0}" -gt 1 ]; do
    c=$(cmd_of "$p"); case $c in *Runner.Worker*) echo "worker $p"; return ;; esac
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
  echo "pid $PPID"
}
alive() { # kind pid
  local c; c=$(cmd_of "$2") || return 1; [ -n "$c" ] || return 1
  [ "$1" = worker ] || return 0
  case $c in *Runner.Worker*) return 0 ;; esac; return 1
}
lock() {
  until mkdir "$D/.lock" 2>/dev/null; do
    # a lock older than a minute was left by a killed hook
    [ -n "$(find "$D/.lock" -maxdepth 0 -mmin +1 2>/dev/null)" ] && rmdir "$D/.lock" 2>/dev/null
    sleep 0.2
  done
}
unlock() { rmdir "$D/.lock" 2>/dev/null; }
sweep() {
  local f kind name
  for f in "$D"/slot.*; do
    [ -e "$f" ] || continue
    read -r kind name < "$f"
    alive "$kind" "\${f##*.}" || { rm -f "$f"; log "freed the stale slot of $name"; }
  done
}
held() { local n=0 f; for f in "$D"/slot.*; do [ -e "$f" ] && n=$((n + 1)); done; echo $n; }

read -r kind me <<< "$(worker)"
case \${1:-} in
  started)
    t0=$(date +%s); said=0
    while :; do
      lock; sweep; n=$(held)
      if [ -e "$D/slot.$me" ] || [ "$n" -lt "$max" ]; then
        echo "$kind \${RUNNER_NAME:-?}" > "$D/slot.$me"; unlock
        log "slot taken ($(held)/$max busy on this Mac)"; exit 0
      fi
      unlock
      if [ $(( $(date +%s) - t0 )) -ge "$wait_sec" ]; then log "no free slot after \${wait_sec}s ($n/$max busy); running anyway"; exit 0; fi
      [ $said = 1 ] || { log "waiting for a slot ($n/$max busy on this Mac)"; said=1; }
      sleep "$poll"
    done ;;
  completed)
    lock; rm -f "$D/slot.$me"; sweep; unlock; log "slot released" ;;
esac
exit 0
`;

/**
 * Install runners: $1 repo, $2 tarball name in the cache, $3 its SHA-256, $4 labels, $5 max jobs, $6 1 = overwrite max,
 * the rest runner names. The registration token is the first line of stdin and reaches only config.sh, in its env.
 */
export const INSTALL = `${DIRS}
IFS= read -r tok || true
repo=$1; tgz="$R/.cache/$2"; sha=$3; labels=$4; max=$5; setmax=$6; shift 6
gui_ok || { echo "dasks-ci: $(id -un) has no login session on this Mac (gui/$uid); nothing registered" >&2; exit 4; }
mkdir -p "$R" "$S/hooks"
cat > "$S/hooks/job-hook.sh.tmp" <<'DASKS_CI_HOOK'
${HOOK}DASKS_CI_HOOK
chmod +x "$S/hooks/job-hook.sh.tmp" && mv "$S/hooks/job-hook.sh.tmp" "$S/hooks/job-hook.sh"
for m in started completed; do printf '#!/bin/bash\\nexec "%s" %s\\n' "$S/hooks/job-hook.sh" "$m" > "$S/hooks/job-$m.sh"; chmod +x "$S/hooks/job-$m.sh"; done
if [ "$setmax" = 1 ] || [ ! -s "$S/max" ]; then echo "$max" > "$S/max"; fi
echo "machine-wide job cap: $(cat "$S/max") ($S/max)"
fail=0
for name in "$@"; do
  d="$R/$name"
  mine=$(cat "$d/.dasks-repo" 2>/dev/null)
  if [ -n "$mine" ] && [ "$mine" != "$repo" ]; then echo "$name: this dir belongs to $mine, not $repo; left as it is" >&2; fail=1; continue; fi
  if [ -f "$d/.runner" ]; then
    echo "$name: already configured, not registered again"
  else
    mkdir -p "$d"
    printf '%s\\n' "$repo" > "$d/.dasks-repo"
    # .dasks-unpacked is written only after a whole, checked extract; without it the package is unpacked again.
    if [ ! -f "$d/.dasks-unpacked" ]; then
      got=$(shasum -a 256 "$tgz" 2>/dev/null | cut -d' ' -f1)
      [ "$got" = "$sha" ] || { echo "$name: $tgz is missing or its SHA-256 does not match; not unpacked" >&2; fail=1; continue; }
      tar -xzf "$tgz" -C "$d" || { echo "$name: unpack failed" >&2; fail=1; continue; }
      printf '%s\\n' "$sha" > "$d/.dasks-unpacked"
    fi
    echo "$name: registering"
    (cd "$d" && ACTIONS_RUNNER_INPUT_TOKEN="$tok" ./config.sh --unattended --url "https://github.com/$repo" --name "$name" --labels "$labels" --work _work --replace) \\
      || { echo "$name: config.sh failed" >&2; fail=1; continue; }
  fi
  env_new=$( { grep -v '^ACTIONS_RUNNER_HOOK_JOB_' "$d/.env" 2>/dev/null; echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=$S/hooks/job-started.sh"; echo "ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$S/hooks/job-completed.sh"; } )
  restart=0
  if [ "$env_new" != "$(cat "$d/.env" 2>/dev/null)" ]; then printf '%s\\n' "$env_new" > "$d/.env"; restart=1; fi
  if [ ! -f "$d/.service" ]; then
    (cd "$d" && ./svc.sh install) || { echo "$name: svc.sh install failed" >&2; fail=1; continue; }
  fi
  plist=$(cat "$d/.service" 2>/dev/null); label=$(label_of "$d")
  [ -n "$label" ] && [ -f "$plist" ] || { echo "$name: svc.sh made no LaunchAgent ($plist)" >&2; fail=1; continue; }
  if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
    [ $restart = 1 ] && launchctl kickstart -k "gui/$uid/$label" >/dev/null 2>&1
  else
    launchctl bootstrap "gui/$uid" "$plist" || { echo "$name: launchctl bootstrap gui/$uid failed" >&2; fail=1; continue; }
  fi
  launchctl kickstart "gui/$uid/$label" >/dev/null 2>&1
  echo "$name: service started in gui/$uid"
done
exit $fail
`;

/** Remove runners: $1 repo, the rest runner names. The removal token is the first line of stdin, for config.sh only. */
export const REMOVE = `${DIRS}
IFS= read -r tok || true
repo=$1; shift
fail=0
for name in "$@"; do
  d="$R/$name"
  [ -d "$d" ] || { echo "$name: no such runner here"; continue; }
  if [ -f "$d/.service" ]; then
    plist=$(cat "$d/.service" 2>/dev/null); label=$(label_of "$d")
    [ -n "$label" ] && launchctl bootout "gui/$uid/$label" >/dev/null 2>&1
    (cd "$d" || exit 1; ./svc.sh stop >/dev/null 2>&1; ./svc.sh uninstall)
    # Never delete a runner whose LaunchAgent is still there or loaded: it would start a missing program.
    if [ -f "$d/.service" ] || { [ -n "$plist" ] && [ -e "$plist" ]; } || { [ -n "$label" ] && launchctl print "gui/$uid/$label" >/dev/null 2>&1; }; then
      echo "$name: svc.sh uninstall did not remove the service; runner kept (run ./svc.sh uninstall in $d, then remove again)" >&2; fail=1; continue
    fi
  fi
  if [ -f "$d/.runner" ]; then
    (cd "$d" && ACTIONS_RUNNER_INPUT_TOKEN="$tok" ./config.sh remove) || { echo "DASKS-CI-KEPT $name"; fail=1; continue; }
  fi
  rm -rf "$d" && echo "$name: removed"
done
exit $fail
`;

/** Read-only: for each runner name, whether its LaunchAgent is loaded in gui/<uid>. */
export const LOADED = `${DIRS}
for name in "$@"; do
  label=$(label_of "$R/$name")
  if [ -n "$label" ] && launchctl print "gui/$uid/$label" >/dev/null 2>&1; then printf 'loaded\\t%s\\n' "$name"; else printf 'missing\\t%s\\n' "$name"; fi
done
`;

/** Delete runner dirs whose registration is already gone from GitHub: the names. */
export const DELETE_DIRS = `${DIRS}
for name in "$@"; do
  if [ -f "$R/$name/.service" ]; then echo "$name: its service is still installed; kept" >&2; continue; fi
  rm -rf "$R/$name" && echo "$name: removed"
done
`;

// The oldest Node release of each supported line that has the published security fixes. Raise a floor when a security
// release ships. An odd-numbered or end-of-life line gets no fixes and is refused; an even line newer than this list (a
// release line that came out after this kit) is allowed, since the kit cannot know its floor yet.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const NODE_FLOORS: Record<number, string> = { 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' };

const RELEASE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** null when this Node has the security fixes, else why not and what to do. */
export function nodeProblem(version: string): string | null {
  const m = RELEASE.exec(version);
  if (!m) return `node ${version} is not a release build (rc, nightly or custom). Fix: install a release: brew upgrade node`;
  const [major, minor, patch] = m.slice(1).map(Number);
  const newest = Math.max(...Object.keys(NODE_FLOORS).map(Number));
  if (major > newest && major % 2 === 0) return null;
  const floor = NODE_FLOORS[major];
  if (!floor) return `node ${version} gets no security fixes (supported: ${Object.values(NODE_FLOORS).map((f) => `${f.split('.')[0]}.x`).join(', ')}). Fix: brew upgrade node`;
  const [, fm, fp] = floor.split('.').map(Number);
  if (minor > fm || (minor === fm && patch >= fp)) return null;
  return `node ${version} lacks security fixes in ${floor}. Fix: brew upgrade node`;
}

// Run as a script (install.sh): the module URL is the real path, so compare against argv's real path (spaces, symlinks).
const script = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? '')).href; } catch { return ''; } })();
if (import.meta.url === script) {
  const why = nodeProblem(process.versions.node);
  if (why) { console.error(why); process.exit(1); }
}

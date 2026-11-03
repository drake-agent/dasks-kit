// The oldest Node release of each supported line that has the published security fixes. Raise a floor when a security
// release ships; a line not listed (odd-numbered or past end of life) gets no fixes and is refused.
export const NODE_FLOORS: Record<number, string> = { 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' };

const parts = (v: string) => v.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);

/** null when this Node has the security fixes, else why not and what to do. */
export function nodeProblem(version: string): string | null {
  const [major, minor, patch] = parts(version);
  const newest = Math.max(...Object.keys(NODE_FLOORS).map(Number));
  if (major > newest && major % 2 === 0) return null;
  const floor = NODE_FLOORS[major];
  if (!floor) return `node ${version} gets no security fixes (supported: ${Object.values(NODE_FLOORS).map((f) => `${f.split('.')[0]}.x`).join(', ')}). Fix: brew upgrade node`;
  const [, fm, fp] = parts(floor);
  if (minor > fm || (minor === fm && patch >= fp)) return null;
  return `node ${version} lacks security fixes in ${floor}. Fix: brew upgrade node`;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const why = nodeProblem(process.versions.node);
  if (why) { console.error(why); process.exit(1); }
}

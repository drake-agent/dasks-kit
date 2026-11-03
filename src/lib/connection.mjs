// How every client on this Mac reaches the board: the MCP server, the dasks/gb and dask CLIs, the merge gate and the
// runner. install.sh writes ~/.dasks/client.json (mode 600): {"url", "token", "machine"}. The environment wins
// (DASKS_URL, DASKS_TOKEN, DASKS_MACHINE), so a test or a second board can point a client elsewhere without editing it.
// bin/dask and bin/dask-merge-gate (Python) read the same file with the same rules.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

export const DEFAULT_URL = 'http://127.0.0.1:4747';
const TOKEN_RE = /^[A-Za-z0-9_-]{1,200}$/;

/** The Dasks home folder: DASKS_HOME, else ~/.dasks. */
export function dasksHome() {
  return process.env.DASKS_HOME || path.join(os.homedir(), '.dasks');
}

export function clientFile() {
  return path.join(dasksHome(), 'client.json');
}

/** The stored connection, {} when there is none or it is unreadable. */
export function readClient() {
  try {
    const j = JSON.parse(fs.readFileSync(clientFile(), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

/** The CA file that signed an https board's certificate ('' = the system's CAs only): DASKS_CA_FILE, else client.json
 *  `ca` (install.sh --ca-file). */
export function boardCa() {
  return String(process.env.DASKS_CA_FILE || readClient().ca || '');
}

let caTrusted = false;
/** Add boardCa() to this process's trusted CAs (fetch included), once. Every client gets the URL through boardUrl(),
 *  so it runs before the first request. */
export function trustBoardCa() {
  if (caTrusted) return;
  caTrusted = true;
  const file = boardCa();
  if (!file) return;
  let pem;
  try { pem = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error(`the board's CA file ${file} is unreadable (${e.code || e.message})`); }
  if (typeof tls.setDefaultCACertificates !== 'function') throw new Error('a board CA file (DASKS_CA_FILE / client.json ca) needs Node 22.19 or newer');
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), pem]);
}

/** Board base URL without a trailing slash (http:// on this Mac, https:// for a board with TLS). */
export function boardUrl() {
  trustBoardCa();
  const u = process.env.DASKS_URL || readClient().url || DEFAULT_URL;
  return String(u).replace(/\/+$/, '');
}

/** The agent token for writes ('' = none). A malformed value throws without quoting it: Node's header error would. */
export function boardToken() {
  const t = String(process.env.DASKS_TOKEN ?? readClient().token ?? '').trim();
  if (t && !TOKEN_RE.test(t)) throw new Error('the Dasks token (DASKS_TOKEN or ~/.dasks/client.json) is malformed; its value is not shown');
  return t;
}

/** {Authorization: Bearer …} or {} when there is no token.
 *  @returns {Record<string, string>} */
export function authHeader(token = boardToken()) {
  const t = String(token ?? '').trim();
  if (!t) return {};
  if (!TOKEN_RE.test(t)) throw new Error('the Dasks token is malformed; its value is not shown');
  return { Authorization: `Bearer ${t}` };
}

/** This Mac's short name in actor names (claude-code@<machine>, runner@<machine>): DASKS_MACHINE, the stored name, else
 *  the host name (lowercase letters, digits and -, at most 16 so every actor name fits in 40 characters). */
export function machineName() {
  const clean = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16);
  return clean(process.env.DASKS_MACHINE) || clean(readClient().machine) || clean(os.hostname().split('.')[0]) || 'local';
}

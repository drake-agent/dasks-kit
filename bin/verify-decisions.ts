#!/usr/bin/env node
// Verify the decision ledger: hash chain + HMAC of every line (src/lib/decisions.ts).
//   bin/verify-decisions.ts [--key <ledger.key>] [--head <ledger.head> | --no-head] [ledger.jsonl]
// Defaults: key = $DASKS_SECRETS_DIR/ledger.key (~/.dasks/secrets/ledger.key), head = ledger.head next to it,
// ledger = data/decisions/ledger.jsonl. The head catches lines cut off the end; --no-head checks the chain only.
// The git witness (data/decisions.witness.json in the last commit of --root, default the board data repo) catches a ledger
// deleted or cut together with its head.
// Exit 0 = intact, 1 = tampered (names the first bad line), 2 = cannot read the input. Never prints the key.
import fs from 'node:fs';
import path from 'node:path';
import { verifyLedger, witnessProblem } from '../src/lib/decisions.ts';
import { type Head, readHead } from '../src/lib/ledger-head.ts';
import { secretsDir } from '../src/lib/auth.ts';
import { boardRoot } from '../src/lib/config.ts';

const args = process.argv.slice(2);
let keyFile = path.join(secretsDir(), 'ledger.key');
const k = args.indexOf('--key');
if (k >= 0) { keyFile = args[k + 1]; args.splice(k, 2); }
let headFile: string | null = path.join(path.dirname(keyFile), 'ledger.head');
const h = args.indexOf('--head');
if (h >= 0) { headFile = args[h + 1]; args.splice(h, 2); }
const nh = args.indexOf('--no-head');
if (nh >= 0) { headFile = null; args.splice(nh, 1); }
const rt = args.indexOf('--root');
let root = boardRoot();
if (rt >= 0) { root = path.resolve(args[rt + 1]); args.splice(rt, 2); }
const ledger = args[0] || path.join(root, 'data/decisions/ledger.jsonl');
const gone = witnessProblem(root, ledger);
if (gone) { console.log(`FAIL ${ledger}: ${gone}`); process.exit(1); }

let key: Buffer; let text: string; let head: Head | null | undefined;
try {
  const hex = fs.readFileSync(keyFile, 'utf8').trim();
  if (!/^[0-9a-f]{64,}$/.test(hex)) throw new Error(`${keyFile}: not a hex key`);
  key = Buffer.from(hex, 'hex');
  text = fs.readFileSync(ledger, 'utf8');
  head = headFile ? readHead(headFile) : undefined;
} catch (e: any) { console.error(`cannot read: ${e.message}`); process.exit(2); }

const r = verifyLedger(text, key, head);
if (r.ok) { console.log(`OK ${ledger}: ${r.count} decision(s), chain and HMAC intact${head === undefined ? ' (head not checked: --no-head)' : ', head matches'}`); process.exit(0); }
console.log(`FAIL ${ledger}: line ${r.line}: ${r.error} (${r.count} line(s) verified)`);
process.exit(1);

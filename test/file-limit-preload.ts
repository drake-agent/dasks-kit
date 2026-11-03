// Holds --test-timeout per test file on every Node version (newer Node applies it per test only).
const flag = process.execArgv.findLast((a) => a.startsWith('--test-timeout='));
const ms = Number(flag?.slice('--test-timeout='.length));

if (ms > 0) {
  setTimeout(() => {
    process.stderr.write(`test timed out after ${ms}ms: whole file ${process.argv[1]}\n`);
    process.exit(1);
  }, ms).unref();
}

// Server times carry this machine's offset; the suite runs in UTC so stamps agree on every machine (a test that is about
// another zone sets its own).
process.env.TZ = 'UTC';
// The installer refuses a Node without its security fixes; the suite must also run on one (node-floor.test.ts tests that).
process.env.DASKS_ALLOW_UNPATCHED_NODE = '1';

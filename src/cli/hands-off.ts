// dasks hands-off on|off|status: flip hands-off mode (src/lib/hands-off.ts) in this board's config.json. Run it on the
// board's Mac. The server reads the switch on each request, so no restart is needed.
import fs from 'node:fs';
import path from 'node:path';
import { boardRoot, configFile } from '../lib/config.ts';

const [cmd] = process.argv.slice(2);
if (!['on', 'off', 'status'].includes(cmd ?? '')) { console.error('usage: dasks hands-off on | off | status'); process.exit(2); }
const file = configFile(boardRoot());
let cfg: Record<string, any> = {};
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e: any) { if (e.code !== 'ENOENT') { console.error(`dasks hands-off: cannot read ${file}: ${e.message}`); process.exit(1); } }
if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { console.error(`dasks hands-off: ${file} is not a JSON object`); process.exit(1); }
const was = cfg.hands_off?.enabled === true;
if (cmd === 'status') {
  console.log(`hands-off: ${was ? 'on' : 'off'} (${file})`);
} else {
  const on = cmd === 'on';
  if (on !== was) {
    cfg.hands_off = { ...(cfg.hands_off && typeof cfg.hands_off === 'object' ? cfg.hands_off : {}), enabled: on };
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }
  console.log(`hands-off: ${on ? 'on' : 'off'}${on === was ? ' (unchanged)' : ''} (${file}). No server restart needed: the board reads it on each request.`);
}

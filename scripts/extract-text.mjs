/**
 * extract-text.mjs — dump the rendered visible text of every route to a file
 * so the Arabic copy can be reviewed for correctness.
 */
import fs from 'node:fs';
import { connect, sleep } from './cdp-lib.mjs';

const BASE = 'http://localhost:8090';
const ROUTES = ['/', '/chat', '/workspace', '/agents', '/files', '/library', '/integrations', '/settings', '/studio', '/operations', '/analytics'];

const cdp = await connect();
await cdp.setViewport(1440, 900, false, 1);
const out = [];
for (const r of ROUTES) {
  await cdp.navigate(BASE + r);
  await sleep(2200);
  const text = await cdp.eval('document.body.innerText');
  out.push(`\n\n===== ROUTE ${r} =====\n${text}`);
}
fs.writeFileSync('/workspace/.screenshots/rendered-text.txt', out.join('\n'));
console.log('wrote /workspace/.screenshots/rendered-text.txt');
console.log('total chars:', out.join('').length);
process.exit(0);

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve('dist');
const server = createServer(async (request, response) => {
  const route = request.url === '/' ? '/index.html' : request.url;
  const requested = route.replace(/^\//, '').split('?')[0];
  const file = path.join(root, requested.includes('.') ? requested : `${requested}.html`);
  try { const data = await readFile(file); response.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream', 'x-content-type-options': 'nosniff' }); response.end(data); }
  catch { response.writeHead(404); response.end('not found'); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const dump = await new Promise((resolve, reject) => {
  const child = spawn(process.env.CHROMIUM_BIN || 'chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--dump-dom', `http://127.0.0.1:${port}/chat`], { stdio: ['ignore', 'pipe', 'pipe'] }); // security-scan:allow private-url-literal (local loopback bind, not a hardcoded host)
  let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject); child.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`CHROMIUM_EXIT_${code}:${stderr.slice(0, 500)}`)));
});
server.close();
if (!dump.stdout.toLowerCase().includes('<html') || !dump.stdout.includes('root')) throw new Error(`BROWSER_SMOKE_CONTENT_ASSERTION_FAILED:${dump.stdout.slice(0, 500)}`);
console.log('Chromium smoke passed: /chat rendered HTML successfully');

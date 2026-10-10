#!/usr/bin/env node
/**
 * capture-shots.mjs
 * Drives the already-running Chromium (CDP on :9222) to capture real screenshots
 * of the Semo0o web app at desktop / tablet / mobile breakpoints.
 *
 * Usage:
 *   node scripts/capture-shots.mjs <baseUrl> <outDir> [routesJsonFile]
 *
 * It sets Emulation.setDeviceMetricsOverride per breakpoint so the responsive
 * layout actually reflows, navigates to each route, waits for render, and saves
 * a PNG per (breakpoint, route).
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:8090';
const OUT = process.argv[3] || '/workspace/.screenshots/app';
const ROUTES_FILE = process.argv[4] || '';

const BREAKPOINTS = [
  { key: 'desktop', width: 1440, height: 900, mobile: false, dsf: 1 },
  { key: 'tablet', width: 834, height: 1112, mobile: true, dsf: 1 },
  { key: 'mobile', width: 390, height: 844, mobile: true, dsf: 2 },
];

const DEFAULT_ROUTES = [
  { name: 'home', path: '/' },
  { name: 'chat', path: '/chat' },
  { name: 'projects', path: '/workspace' },
  { name: 'tasks', path: '/agents' },
  { name: 'files', path: '/files' },
  { name: 'agents', path: '/library' },
  { name: 'integrations', path: '/integrations' },
  { name: 'settings', path: '/settings' },
  { name: 'studio', path: '/studio' },
  { name: 'operations', path: '/operations' },
  { name: 'analytics', path: '/analytics' },
];

const ROUTES = ROUTES_FILE
  ? JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8'))
  : DEFAULT_ROUTES;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPageTarget() {
  const res = await fetch('http://localhost:9222/json/list');
  const list = await res.json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('No page target found on CDP :9222');
  return page.webSocketDebuggerUrl;
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        const handlers = this.events.get(msg.method) || [];
        handlers.forEach((h) => h(msg.params));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  once(method, timeout = 15000) {
    return new Promise((resolve) => {
      const handler = (params) => {
        const arr = this.events.get(method) || [];
        this.events.set(method, arr.filter((h) => h !== handler));
        resolve(params);
      };
      const arr = this.events.get(method) || [];
      arr.push(handler);
      this.events.set(method, arr);
      setTimeout(() => {
        const a = this.events.get(method) || [];
        this.events.set(method, a.filter((h) => h !== handler));
        resolve(null);
      }, timeout);
    });
  }
}

async function connect() {
  const url = await getPageTarget();
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return new CDP(ws);
}

async function evalJs(cdp, expr, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise,
  });
  return r?.result?.value;
}

async function waitForRender(cdp, ms = 1200) {
  // wait for fonts + a couple of animation frames
  try {
    await evalJs(cdp, 'document.fonts && document.fonts.ready ? document.fonts.ready.then(()=>true) : true', true);
  } catch {}
  await sleep(ms);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const cdp = await connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const manifest = [];
  for (const bp of BREAKPOINTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: bp.width,
      height: bp.height,
      deviceScaleFactor: bp.dsf,
      mobile: bp.mobile,
    });
    for (const route of ROUTES) {
      const url = BASE.replace(/\/$/, '') + route.path;
      const loaded = cdp.once('Page.loadEventFired', 12000);
      try {
        await cdp.send('Page.navigate', { url });
      } catch (e) {
        console.error(`nav fail ${url}: ${e.message}`);
      }
      await loaded;
      await waitForRender(cdp, route.wait || 1500);
      // detect SPA fallback / not found
      const title = await evalJs(cdp, 'document.title || ""');
      const bodyLen = await evalJs(cdp, 'document.body ? document.body.innerText.length : 0');
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const file = path.join(OUT, `${bp.key}_${route.name}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      manifest.push({ breakpoint: bp.key, route: route.name, path: route.path, url, file, title, bodyLen });
      console.log(`[ok] ${bp.key.padEnd(7)} ${route.name.padEnd(13)} -> ${file}  (text=${bodyLen})`);
    }
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nWrote ${manifest.length} screenshots to ${OUT}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});

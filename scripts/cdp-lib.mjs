/**
 * cdp-lib.mjs — tiny CDP helper shared by capture/diagnostic scripts.
 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getPageTarget() {
  const res = await fetch('http://localhost:9222/json/list');
  const list = await res.json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('No page target found on CDP :9222');
  return page.webSocketDebuggerUrl;
}

export class CDP {
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
        (this.events.get(msg.method) || []).forEach((h) => h(msg.params));
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
        this.events.set(method, (this.events.get(method) || []).filter((h) => h !== handler));
        resolve(params);
      };
      this.events.set(method, [...(this.events.get(method) || []), handler]);
      setTimeout(() => {
        this.events.set(method, (this.events.get(method) || []).filter((h) => h !== handler));
        resolve(null);
      }, timeout);
    });
  }
  async evaluate(expr, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    if (r && r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval error');
    return r?.result?.value;
  }
  async navigate(url, timeout = 12000) {
    const loaded = this.once('Page.loadEventFired', timeout);
    await this.send('Page.navigate', { url });
    await loaded;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const fs = await import('node:fs');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  async setViewport(width, height, mobile = false, dsf = 1) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf, mobile });
  }
  async clearViewport() {
    await this.send('Emulation.clearDeviceMetricsOverride');
  }
}

export async function connect() {
  const url = await getPageTarget();
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return cdp;
}

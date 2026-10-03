import { randomUUID } from 'node:crypto';

const id = (prefix) => `${prefix}_${randomUUID()}`;

/**
 * Browser Agent over Chrome DevTools Protocol.
 *
 * The adapter intentionally receives an already-authorized CDP websocket URL;
 * it never handles credentials. It captures DOM, screenshots, console output,
 * network failures, and browser verification evidence in one run object.
 */
export class BrowserAgent {
  constructor(webSocketUrl, options = {}) {
    if (!webSocketUrl || !/^wss?:\/\//i.test(webSocketUrl)) throw new Error('BROWSER_CDP_URL_REQUIRED');
    this.url = webSocketUrl;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.onmessage = (event) => this.#onMessage(JSON.parse(event.data));
    this.socket.onerror = () => this.events.push({ type: 'socket-error', at: new Date().toISOString() });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('BROWSER_CONNECT_TIMEOUT')), this.timeoutMs);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('BROWSER_CONNECT_ERROR')); }, { once: true });
    });
    await this.command('Runtime.enable');
    await this.command('Page.enable');
    await this.command('Network.enable');
    return this;
  }

  #onMessage(message) {
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.code}:${message.error.message}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method) this.events.push({ type: message.method, params: message.params ?? {}, at: new Date().toISOString() });
  }

  command(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('BROWSER_NOT_CONNECTED');
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`BROWSER_COMMAND_TIMEOUT:${method}`)); }, this.timeoutMs);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    });
  }

  async navigate(url) {
    const result = await this.command('Page.navigate', { url });
    await this.waitForLoad();
    return { url, result };
  }

  async waitForLoad(timeoutMs = this.timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.events.some((event) => event.type === 'Page.loadEventFired')) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('BROWSER_LOAD_TIMEOUT');
  }

  async evaluate(expression, returnByValue = true) {
    const result = await this.command('Runtime.evaluate', { expression, returnByValue, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'BROWSER_EVALUATION_ERROR');
    return result.result?.value;
  }

  async click(selector) {
    return this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('selector not found'); el.click(); return true; })()`);
  }

  async type(selector, text) {
    const safe = JSON.stringify(String(text));
    return this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('selector not found'); el.focus(); el.value = ${safe}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  }

  async scroll(x = 0, y = 600) {
    return this.evaluate(`window.scrollBy(${Number(x) || 0}, ${Number(y) || 0}); window.scrollY`);
  }

  async dom() {
    return this.evaluate('document.documentElement.outerHTML');
  }

  async screenshot(format = 'png') {
    const result = await this.command('Page.captureScreenshot', { format });
    return Buffer.from(result.data, 'base64');
  }

  async verify(checks = []) {
    const results = [];
    for (const check of checks) {
      try {
        const value = await this.evaluate(check.expression);
        results.push({ id: check.id ?? id('check'), description: check.description ?? check.expression, ok: Boolean(value), value });
      } catch (error) {
        results.push({ id: check.id ?? id('check'), description: check.description ?? check.expression, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { ok: results.every((result) => result.ok), results, consoleErrors: this.events.filter((event) => event.type === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(event.params?.type)), networkErrors: this.events.filter((event) => event.type === 'Network.loadingFailed') };
  }

  evidence() { return { runId: id('browser'), capturedAt: new Date().toISOString(), events: this.events }; }

  async close() { if (this.socket) this.socket.close(); this.socket = null; }
}

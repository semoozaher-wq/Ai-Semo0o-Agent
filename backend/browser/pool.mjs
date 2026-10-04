import { BrowserAgent } from '../../phase2-core/browser-agent.mjs';

export class BrowserPool {
  constructor({ maxConcurrent = 2, maxQueued = 20, timeoutMs = 30_000, createAgent = (url, options) => new BrowserAgent(url, options) } = {}) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32) throw new Error('BROWSER_POOL_CONCURRENCY_INVALID');
    if (!Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > 1000) throw new Error('BROWSER_POOL_QUEUE_INVALID');
    this.maxConcurrent = maxConcurrent;
    this.maxQueued = maxQueued;
    this.timeoutMs = timeoutMs;
    this.createAgent = createAgent;
    this.active = 0;
    this.waiting = [];
  }

  status() { return { active: this.active, queued: this.waiting.length, maxConcurrent: this.maxConcurrent, maxQueued: this.maxQueued }; }

  run(webSocketUrl, task) {
    if (this.waiting.length >= this.maxQueued && this.active >= this.maxConcurrent) return Promise.reject(new Error('BROWSER_POOL_QUEUE_FULL'));
    return new Promise((resolve, reject) => {
      this.waiting.push({ webSocketUrl, task, resolve, reject });
      this.#drain();
    });
  }

  #drain() {
    while (this.active < this.maxConcurrent && this.waiting.length) {
      const item = this.waiting.shift();
      this.active += 1;
      this.#execute(item).finally(() => { this.active -= 1; this.#drain(); });
    }
  }

  async #execute({ webSocketUrl, task, resolve, reject }) {
    let browser;
    let result;
    let failure;
    try {
      browser = this.createAgent(webSocketUrl, { timeoutMs: this.timeoutMs });
      await browser.connect();
      result = await task(browser);
    } catch (error) { failure = error; }
    finally {
      if (browser) {
        try { await browser.close(); } catch { /* cleanup must not mask task result */ }
      }
    }
    if (failure) reject(failure);
    else resolve(result);
  }
}

import { BrowserAgent } from '../../phase2-core/browser-agent.mjs';

export async function runBrowserTask({ webSocketUrl, url, checks = [], actions = [] }) {
  const browser = new BrowserAgent(webSocketUrl);
  await browser.connect();
  try {
    const results = [];
    if (url) results.push(await browser.navigate(url));
    for (const action of actions) {
      if (action.type === 'click') results.push(await browser.click(action.selector));
      else if (action.type === 'type') results.push(await browser.type(action.selector, action.text));
      else if (action.type === 'scroll') results.push(await browser.scroll(action.x, action.y));
      else throw new Error(`BROWSER_ACTION_NOT_ALLOWED:${action.type}`);
    }
    const verification = await browser.verify(checks);
    return { ok: verification.ok, results, verification, evidence: browser.evidence(), screenshot: await browser.screenshot() };
  } finally { await browser.close(); }
}

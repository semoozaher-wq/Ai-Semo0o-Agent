/**
 * smoke.mjs — functional smoke test against the running web app.
 * Verifies: RTL direction, sidebar placement, client-side (SPA) navigation
 * between sections, and the home composer creating a conversation.
 */
import { connect, sleep } from './cdp-lib.mjs';

const BASE = 'http://localhost:8090';
const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`); };

const CLICK_BY_TEXT = (text) => `
(() => {
  const els = [...document.querySelectorAll('div[role="link"],a,[role="link"]')];
  const el = els.find(e => (e.textContent||'').trim().includes(${JSON.stringify(text)}));
  if (!el) return 'NOT_FOUND';
  const r = el.getBoundingClientRect();
  const o = { bubbles:true, cancelable:true, clientX:r.x+r.width/2, clientY:r.y+r.height/2 };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new MouseEvent('mousedown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o));
  el.dispatchEvent(new MouseEvent('mouseup', o));
  el.dispatchEvent(new MouseEvent('click', o));
  return 'CLICKED';
})()`;

async function main() {
  const cdp = await connect();
  await cdp.setViewport(1440, 900, false, 1);
  await cdp.navigate(BASE + '/');
  await sleep(2500);

  // 1) RTL
  const dir = await cdp.evaluate(`getComputedStyle(document.body).direction`);
  const htmlDir = await cdp.evaluate(`document.documentElement.getAttribute('dir') || (document.body.getAttribute('dir')) || ''`);
  rec('RTL direction on body', dir === 'rtl', `direction=${dir}, dir attr="${htmlDir}"`);

  // 2) Sidebar on the LEFT in RTL (find element containing the nav label الرئيسية)
  const side = await cdp.evaluate(`
    (() => {
      const el = [...document.querySelectorAll('div[role="link"]')].find(e => (e.textContent||'').includes('الرئيسية'));
      if (!el) return null;
      let box = el.getBoundingClientRect();
      // walk up to the rail container (width < 400)
      let cur = el;
      while (cur && cur.getBoundingClientRect().width < 120) cur = cur.parentElement;
      const r = (cur||el).getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x), w: Math.round(r.width), vw: window.innerWidth });
    })()`);
  let sidebarLeft = false;
  if (side) { const s = JSON.parse(side); sidebarLeft = s.x < 40 && s.w < 500; rec('Sidebar anchored LEFT (RTL)', sidebarLeft, side); }
  else rec('Sidebar anchored LEFT (RTL)', false, 'nav link not found');

  // 3) SPA navigation (no full reload)
  await cdp.evaluate(`window.__navMarker = 'alive'`);
  const click1 = await cdp.evaluate(CLICK_BY_TEXT('المحادثات'));
  await sleep(1800);
  const url1 = await cdp.evaluate('location.pathname');
  const marker1 = await cdp.evaluate(`window.__navMarker`);
  rec('SPA nav -> /chat', click1 === 'CLICKED' && url1 === '/chat' && marker1 === 'alive',
      `click=${click1} path=${url1} noReload=${marker1 === 'alive'}`);

  const click2 = await cdp.evaluate(CLICK_BY_TEXT('الإعدادات'));
  await sleep(1800);
  const url2 = await cdp.evaluate('location.pathname');
  const marker2 = await cdp.evaluate(`window.__navMarker`);
  rec('SPA nav -> /settings', click2 === 'CLICKED' && url2 === '/settings' && marker2 === 'alive',
      `click=${click2} path=${url2} noReload=${marker2 === 'alive'}`);

  // 4) Composer creates a conversation
  await cdp.navigate(BASE + '/');
  await sleep(3000);
  const CONV = `localStorage.getItem('semo0o:chat.conversations')`;
  const before = await cdp.evaluate(`${CONV} ? JSON.parse(${CONV}).length : 0`);
  const focused = await cdp.evaluate(`
    (() => { const ta = document.querySelector('textarea'); if (!ta) return 'NO_INPUT'; ta.focus(); return 'FOCUSED'; })()`);
  // Real keystrokes at the browser level so React's controlled input updates.
  await cdp.send('Input.insertText', { text: 'اختبار الواجهة: مرحباً Semo0o' });
  await sleep(600);
  const typedValue = await cdp.evaluate(`(()=>{const t=document.querySelector('textarea'); return t? t.value : '';})()`);
  const typed = focused === 'FOCUSED' && typedValue.trim().length > 0 ? 'TYPED' : focused;
  const box = await cdp.evaluate(`(()=>{const b=document.querySelector('[aria-label="إرسال"]'); if(!b)return null; const r=b.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});})()`);
  let sent = 'NO_SEND';
  if (box) {
    const { x, y } = JSON.parse(box);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    sent = 'SENT';
  }
  await sleep(2500);
  const after = await cdp.evaluate(`${CONV} ? JSON.parse(${CONV}).length : 0`);
  const pathNow = await cdp.evaluate('location.pathname');
  rec('Composer send creates conversation', typed === 'TYPED' && after > before,
      `typed=${typed} sent=${sent} convBefore=${before} convAfter=${after} path=${pathNow}`);

  console.log('\nSUMMARY:', results.filter(r=>r.ok).length + '/' + results.length, 'passed');
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });

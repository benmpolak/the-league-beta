/* Offline UX for callable mutations, in a real browser with a stubbed WCSync:
 * disconnected -> consequential actions fail immediately with a reconnect
 * message and nothing is dispatched; no success toast before the server
 * confirms; a pending request blocks double submission; reconnection recovers
 * cleanly and the same action then succeeds; a server rejection surfaces its
 * message and never shows success.
 * Usage: python3 -m http.server 8125 &   node test/offline.ux.test.js */
'use strict';
const puppeteer = require('puppeteer-core');
const chromePath = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let pass = 0, fail = 0;
const chk = (name, ok, detail = '') => {
  if (ok) pass++; else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new' });
  const p = await browser.newPage();
  p.on('pageerror', e => { fail++; console.log('PAGEERROR', e.message.split('\n')[0]); });

  await p.setRequestInterception(true);
  p.on('request', req => req.url().endsWith('/js/sync.js') ? req.abort() : req.continue());
  await p.goto('http://localhost:8125/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => typeof state !== 'undefined');

  // stub sync layer: calls are recorded and resolved by hand from the test
  await p.evaluate(() => {
    window._calls = [];
    window._resolvers = [];
    window.WCSync = {
      league: 'the-league-2627',
      call: (action, data) => new Promise((resolve, reject) => {
        window._calls.push({ action, data });
        window._resolvers.push({ resolve, reject });
      }),
      auth: {
        user: () => ({ uid: 'u-test', email: 'ben@example.com' }),
        sendLink: () => Promise.resolve(),
        completeLink: () => Promise.resolve(false),
        signOut: () => Promise.resolve(),
      },
    };
    const s = freshState();
    s.phase = 'season';
    s.draft.order = s.managers.map(m => m.id);
    window.onSharedSnapshot(JSON.parse(JSON.stringify({
      phase: s.phase, managers: s.managers, settings: s.settings, draft: s.draft,
      lineups: {}, transfers: [], trades: [], covenants: [], waiverMeta: s.waiverMeta,
      adjustments: {}, shirtNums: {}, draftPool: null, windowDraft: null,
      tradeBlock: {}, benchOrders: {}, lobus: {}, hamCup: null,
    })));
    window.onAuthChanged({ uid: 'u-test', email: 'ben@example.com' });
    window.onMembershipSnapshot({ managerId: 1, role: 'commissioner' });
  });
  await sleep(300);
  const toastText = () => p.evaluate(() => document.querySelector('#toast')?.textContent || '');
  const callCount = () => p.evaluate(() => window._calls.length);

  /* 1 — the old "changes will queue" claim is gone from the UI */
  const bodyHtml = await p.evaluate(() => document.body.innerHTML);
  chk('no "changes will queue" claim anywhere in the UI', !/changes will queue/i.test(bodyHtml));

  /* 2 — disconnected: immediate refusal, nothing dispatched */
  await p.evaluate(() => window.onSyncConnection(false));
  await sleep(100);
  const offRes = await p.evaluate(() => serverAct('stadiumSet', { name: 'The Kennel' }).then(() => 'resolved', e => e.message));
  chk('disconnected mutation fails immediately', offRes !== 'resolved', offRes);
  chk('failure message tells the user to reconnect', /offline|reconnect/i.test(await toastText()), await toastText());
  chk('nothing was dispatched while offline', (await callCount()) === 0);
  const pill = await p.evaluate(() => document.querySelector('.conn')?.getAttribute('title') || '');
  chk('conn pill says read-only, not queueing', /read-only/i.test(pill) && !/queue/i.test(pill), pill);

  /* 3 — reconnect: the same action now dispatches and succeeds */
  await p.evaluate(() => window.onSyncConnection(true));
  await sleep(100);
  await p.evaluate(() => { window._sent = serverAct('stadiumSet', { name: 'The Kennel' }).then(() => 'ok', e => 'err:' + e.message); });
  await sleep(50);
  chk('after reconnect the action dispatches', (await callCount()) === 1);

  /* 4 — no success toast before the server confirms; double submission blocked */
  await p.evaluate(() => { document.querySelector('#toast')?.classList.remove('show'); const t = document.querySelector('#toast'); if (t) t.textContent = ''; });
  const dup = await p.evaluate(() => serverAct('stadiumSet', { name: 'Again' }).then(() => 'resolved', e => e.message));
  chk('second submit while pending is refused', /still sending/i.test(dup), dup);
  chk('still only one request in flight', (await callCount()) === 1);
  chk('no success toast while the server has not confirmed', !/published|saved|sent/i.test(await toastText()), await toastText());
  await p.evaluate(() => window._resolvers.shift().resolve({ ok: true }));
  chk('pending action resolves after server confirms', (await p.evaluate(() => window._sent)) === 'ok');

  /* 5 — after settling, the same action can be sent again (clean recovery) */
  await p.evaluate(() => { window._sent2 = serverAct('stadiumSet', { name: 'Round 2' }).then(() => 'ok', e => 'err:' + e.message); });
  await sleep(50);
  chk('action usable again once the previous settled', (await callCount()) === 2);

  /* 6 — server rejection surfaces its message, never success */
  await p.evaluate(() => window._resolvers.shift().reject(new Error('The Committee refused that one.')));
  await sleep(100);
  chk('rejected action reports the server message', (await p.evaluate(() => window._sent2)) === 'err:The Committee refused that one.');
  chk('rejection shows as a toast', /refused/i.test(await toastText()), await toastText());

  /* 7 — a commissioner success-toast site only fires after confirm (publishAll) */
  await p.evaluate(() => { const t = document.querySelector('#toast'); if (t) t.textContent = ''; });
  await p.evaluate(() => publishAll());
  await sleep(50);
  chk('publish dispatched importState', await p.evaluate(() => window._calls.some(c => c.action === 'importState')));
  chk('publish success toast withheld until server confirms', !/published/i.test(await toastText()));
  await p.evaluate(() => window._resolvers.shift().resolve({ ok: true }));
  await sleep(100);
  chk('publish success toast after confirm', /published/i.test(await toastText()), await toastText());

  await browser.close();
  console.log(`\n[offline-ux] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

/* Auth-mode client smoke: with a stubbed WCSync (no real Firebase), prove that
 * (a) the sign-in overlay renders the email form instead of the old team grid,
 * (b) membership arrival grants identity and clears the overlay,
 * (c) an old localStorage whoami grants nothing,
 * (d) mutations dispatch through WCSync.call, not local state writes.
 * Usage: python3 -m http.server 8125 &   node test/authui.smoke.js */
'use strict';
const puppeteer = require('puppeteer-core');
const chromePath = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let pass = 0, fail = 0;
const chk = (name, ok, detail = '') => {
  if (ok) pass++; else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

(async () => {
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new' });
  const p = await browser.newPage();
  p.on('pageerror', e => { fail++; console.log('PAGEERROR', e.message.split('\n')[0]); });

  // block the real sync.js; we inject a stub after app.js boots
  await p.setRequestInterception(true);
  p.on('request', req => req.url().endsWith('/js/sync.js') ? req.abort() : req.continue());

  await p.goto('http://localhost:8125/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => typeof state !== 'undefined');

  // plant a stale device identity from the PIN era, then bring the stub online
  await p.evaluate(() => {
    localStorage.setItem('tl2627-whoami', '5'); // old identity — must grant nothing
    const calls = [];
    window._calls = calls;
    window.WCSync = {
      league: 'the-league-2627',
      call: (action, data) => { calls.push({ action, data }); return Promise.resolve({ ok: true, total: 1, tgw: 2 }); },
      auth: {
        user: () => null,
        sendLink: email => { calls.push({ action: '_sendLink', data: { email } }); return Promise.resolve(); },
        completeLink: () => Promise.resolve(false),
        signOut: () => { calls.push({ action: '_signOut' }); return Promise.resolve(); },
      },
    };
    window.onSyncConnection(true); // connected — mutations are allowed to dispatch
    // a season-phase public snapshot, no pins/claims/autolists (v2 shape)
    const s = freshState();
    s.phase = 'season';
    s.draft.order = s.managers.map(m => m.id);
    delete s.pins;
    window.onSharedSnapshot(JSON.parse(JSON.stringify({
      phase: s.phase, managers: s.managers, settings: s.settings, draft: s.draft,
      lineups: {}, transfers: [], trades: [], covenants: [], waiverMeta: s.waiverMeta,
      adjustments: {}, shirtNums: {}, draftPool: null, windowDraft: null,
      tradeBlock: {}, benchOrders: {}, lobus: {}, hamCup: null,
    })));
  });
  await new Promise(r => setTimeout(r, 300)); // deferred snapshot apply

  chk('stale localStorage identity grants nothing', await p.evaluate(() => whoami === null));
  chk('sign-in overlay shows the email form', await p.evaluate(() =>
    !!document.querySelector('#whoOverlay #whoEmail') && !document.querySelector('#whoOverlay [data-who="5"]')));

  // send-link flow
  await p.evaluate(() => {
    document.querySelector('#whoEmail').value = 'ben@example.com';
    document.querySelector('#whoEmailForm').dispatchEvent(new Event('submit'));
  });
  await new Promise(r => setTimeout(r, 200));
  chk('email link requested through WCSync.auth', await p.evaluate(() =>
    window._calls.some(c => c.action === '_sendLink' && c.data.email === 'ben@example.com')));
  chk('link-sent state renders', await p.evaluate(() =>
    document.querySelector('#whoOverlay')?.textContent.includes('ben@example.com')));

  // membership arrives → identity granted, overlay clears
  await p.evaluate(() => {
    window.onAuthChanged({ uid: 'u-test', email: 'ben@example.com' });
    window.onMembershipSnapshot({ managerId: 1, role: 'commissioner' });
  });
  await new Promise(r => setTimeout(r, 200));
  chk('membership grants identity', await p.evaluate(() => whoami === 1 && isCommissioner()));
  chk('overlay clears once signed in', await p.evaluate(() => !document.querySelector('#whoOverlay')));

  // private snapshot feeds own claims/autolist
  await p.evaluate(() => window.onPrivateSnapshot({ autolist: [10, 20], claims: { 2: [{ in: 30, out: 40 }] } }));
  chk('private node populates own autolist/claims', await p.evaluate(() =>
    JSON.stringify(state.autolists[1]) === '[10,20]' && state.claims[2]?.[1]?.length === 1));

  // a mutation dispatches through the callable, not a local write
  const before = await p.evaluate(() => window._calls.length);
  await p.evaluate(() => setAutolist(1, [99]));
  chk('mutation goes through WCSync.call', await p.evaluate(b =>
    window._calls.slice(b).some(c => c.action === 'autolistSet' && c.data.pids[0] === 99), before));
  await p.evaluate(() => setClaims(1, [{ in: 1, out: 2 }]));
  chk('claims go through WCSync.call', await p.evaluate(() =>
    window._calls.some(c => c.action === 'claimSet')));

  // sign-out control present in the sync area
  chk('sync area shows the signed-in name', await p.evaluate(() =>
    document.querySelector('#whoBtn')?.textContent.includes('Ben')));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

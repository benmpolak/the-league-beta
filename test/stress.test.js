// Draft-night scale: EIGHT real browsers against the live RTDB (throwaway
// league). Simultaneous signings of different players (all must land), an
// 8-way scramble for the same player (exactly one winner), listener fan-out
// convergence, and offline/reconnect behaviour.
// Usage: python3 -m http.server 8143 (from the repo) then node test/stress.test.js
const puppeteer = require('puppeteer-core');
const chromePath = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const curl = a => execFileSync('curl', ['-s', ...a], { encoding: 'utf8' });

const LEAGUE = 'the-league-e2e-test';
// Target selection: emulator (preferred) or an explicitly acknowledged live run.
const EMULATOR_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
if (!EMULATOR_HOST && process.env.LIVE_DB_TESTS !== '1') {
  console.error('Refusing to run against the live RTDB without acknowledgement.');
  console.error('Set FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000 (preferred) or LIVE_DB_TESTS=1.');
  process.exit(2);
}
const NS = 'calciopoli-wc26-default-rtdb';
const DB = EMULATOR_HOST ? `http://${EMULATOR_HOST}`
  : 'https://calciopoli-wc26-default-rtdb.europe-west1.firebasedatabase.app';
const dbUrl = p => EMULATOR_HOST ? `${DB}/${p}.json?ns=${NS}` : `${DB}/${p}.json`;
const CURL_AUTH = EMULATOR_HOST ? ['-H', 'Authorization: Bearer owner'] : [];
console.log(EMULATOR_HOST ? `[db] emulator at ${EMULATOR_HOST} (ns=${NS})` : '[db] LIVE Firebase RTDB (LIVE_DB_TESTS=1)');
const SITE = 'http://localhost:8143';
const N = 8;
let failures = 0;
const check = (l, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${d ? ' — ' + d : ''}`); if (!ok) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function wipe() {
  curl(['-X', 'PUT', '-d', '"setup"', dbUrl(`leagues/${LEAGUE}/phase`), ...CURL_AUTH]);
  curl(['-X', 'DELETE', dbUrl(`leagues/${LEAGUE}`), ...CURL_AUTH]);
}

async function newClient(browser, whoami) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  p.on('dialog', d => d.accept());
  await p.setRequestInterception(true);
  let syncSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'sync.js'), 'utf8')
    .replace(/'the-league-2627'/g, `'${LEAGUE}'`);
  if (EMULATOR_HOST) {
    syncSrc = syncSrc.replace(/databaseURL:\s*'[^']+'/, `databaseURL: 'http://${EMULATOR_HOST}?ns=${NS}'`);
  }
  if (syncSrc.includes('the-league-2627')) throw new Error('sync.js stub failed — refusing to touch the real league');
  p.on('request', req => req.url().includes('js/sync.js')
    ? req.respond({ contentType: 'application/javascript', body: syncSrc }) : req.continue());
  await p.evaluateOnNewDocument(id => { localStorage.clear(); localStorage.setItem('tl2627-whoami', String(id)); }, whoami);
  await p.goto(SITE, { waitUntil: 'networkidle2' });
  await p.waitForFunction('!!window.WCSync', { timeout: 10000 });
  return p;
}

(async () => {
  wipe();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new', protocolTimeout: 300000,
    args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  });

  const A = await newClient(browser, 1);
  await sleep(2000);
  await A.evaluate(() => {
    // quick local draft, one atomic publish — league straight to season
    state.draft.order = state.managers.map(m => m.id);
    const sorted = [...PLAYERS].sort((a, b) => rating(b) - rating(a));
    const taken = new Set();
    let n = 0, guard = 0;
    while (n < totalPicks() && guard++ < 5000) {
      const mid = currentManagerId();
      const p2 = sorted.find(x => !taken.has(x.id) && canPick(mid, x));
      taken.add(p2.id);
      state.draft.picks.push({ managerId: mid, playerId: p2.id, n: ++n });
    }
    state.draftPool = { at: Date.now(), ids: Object.fromEntries(PLAYERS.map(p3 => [p3.id, p3.club])) };
    state.phase = 'season';
    publishAll(); save(); render();
  });
  await sleep(2000);

  console.log(`  … spawning ${N - 1} more clients`);
  const others = [];
  for (let id = 2; id <= N; id++) others.push(await newClient(browser, id));
  const clients = [A, ...others];
  await sleep(2000);
  const online = await Promise.all(clients.map(p => p.evaluate(() => netOn() && state.phase === 'season')));
  check(`${N} clients online with the season live`, online.every(Boolean));

  // the app's trough-signing path, callable per client
  const sign = (page, mid, poolIdx) => page.evaluate(async (m, k) => {
    const cur = currentGwIndex();
    const owned = ownedIdsAt(cur);
    const pool = PLAYERS.filter(pl => !owned.has(pl.id) && pl.pos === 'MF').sort((a, b) => rating(b) - rating(a));
    const inP = pool[k];
    const outId = managerSquad(m).filter(p => p.pos === 'MF').pop().id;
    const ok = await txnArray('transfers', arr => {
      const own2 = ownedIdsGiven(arr, cur);
      if (own2.has(inP.id) || !own2.has(outId)) return null;
      return [...arr, { managerId: m, outId, inId: inP.id, gw: cur, n: arr.length + 1, t: Date.now() }];
    });
    return { inId: inP.id, ok };
  }, mid, poolIdx);

  // wave 1: eight different players, one instant — ALL must land
  const w1 = await Promise.all(clients.map((p, k) => sign(p, k + 1, k)));
  await sleep(3000);
  let cloud = Object.values(JSON.parse(curl([dbUrl(`leagues/${LEAGUE}/transfers`), ...CURL_AUTH])) || {});
  check(`${N}-way burst: every signing of a DIFFERENT player lands`,
    w1.every(x => x.ok) && w1.every(x => cloud.some(t => t && t.inId === x.inId)),
    `cloud holds ${cloud.length}/8`);

  // wave 2: all eight scramble for the SAME player — exactly one winner
  const w2 = await Promise.all(clients.map((p, k) => sign(p, k + 1, 20)));
  await sleep(3000);
  cloud = Object.values(JSON.parse(curl([dbUrl(`leagues/${LEAGUE}/transfers`), ...CURL_AUTH])) || {});
  const target = w2[0].inId;
  const landed = cloud.filter(t => t && t.inId === target).length;
  const winners = w2.filter(x => x.ok).length;
  check(`${N}-way scramble for ONE player: exactly one winner, seven refused`,
    landed === 1 && winners === 1, `landed=${landed}, winners=${winners}`);

  // fan-out: every client converges to the same transfer count
  await sleep(2000);
  const counts = await Promise.all(clients.map(p => p.evaluate(() => state.transfers.length)));
  check('all clients converge to identical state', new Set(counts).size === 1, `counts=${counts.join(',')}`);

  // ---------- offline & reconnect ----------
  const B = clients[1];
  await B.setOfflineMode(true);
  // a txn attempted offline must NOT phantom-succeed locally
  const offSign = B.evaluate(async () => {
    const cur = currentGwIndex();
    const owned = ownedIdsAt(cur);
    const inP = PLAYERS.filter(pl => !owned.has(pl.id) && pl.pos === 'FW').sort((a, b) => rating(b) - rating(a))[0];
    const outId = managerSquad(2).filter(p => p.pos === 'FW').pop().id;
    const pre = state.transfers.length;
    const done = txnArray('transfers', arr => {
      const own2 = ownedIdsGiven(arr, cur);
      if (own2.has(inP.id) || !own2.has(outId)) return null;
      return [...arr, { managerId: 2, outId, inId: inP.id, gw: cur, n: arr.length + 1, t: Date.now() }];
    });
    await new Promise(r => setTimeout(r, 1500));
    const during = state.transfers.length; // still pending — nothing phantom
    const ok = await done; // resolves after reconnect
    return { pre, during, ok, inId: inP.id };
  });
  await sleep(2500);
  await B.setOfflineMode(false);
  const off = await offSign;
  await sleep(3000);
  cloud = Object.values(JSON.parse(curl([dbUrl(`leagues/${LEAGUE}/transfers`), ...CURL_AUTH])) || {});
  // contract: the local view may show the move optimistically while offline,
  // but confirmation (ok/toast) waits for the server, the move lands exactly
  // once on reconnect, and every client converges on the same truth
  const cloudCopies = cloud.filter(t => t && t.inId === off.inId).length;
  const converged = new Set(await Promise.all(clients.map(p => p.evaluate(() => state.transfers.length)))).size === 1;
  check('offline signing: optimistic locally, confirmed only by the server, lands exactly once',
    off.ok === true && cloudCopies === 1 && converged,
    `ok=${off.ok} copies=${cloudCopies} converged=${converged}`);

  // offline lineup edit queues locally and flushes to everyone on reconnect
  await B.setOfflineMode(true);
  const luEdit = await B.evaluate(() => {
    const cur = currentGwIndex();
    const xi = lineupFor(2, cur);
    saveLineup(2, cur, xi); // re-save stamps it; the write queues offline
    return state.lineups[2][`${cur}-t`];
  });
  await B.setOfflineMode(false);
  await sleep(3500);
  const stampSeen = await A.evaluate((ts) => state.lineups?.[2]?.[`${currentGwIndex()}-t`] === ts, luEdit);
  check('offline lineup edit queues and flushes to other devices on reconnect', stampSeen);

  // the after-kick-off tell-tale renders
  const telltale = await A.evaluate(() => {
    const cur = currentGwIndex();
    state.lineups[2][`${cur}-t`] = new Date(gwFrom(cur)).getTime() + 60 * 60 * 1000; // an hour after KO
    const html = lineupStamp(2, cur);
    return html.includes('AFTER KICK-OFF');
  });
  check('clock-cheat tell-tale: post-deadline edits flagged in red', telltale);

  await browser.close();
  wipe();
  console.log(failures ? `\n${failures} FAILURES` : `\nSTRESS + OFFLINE CLEAN — ${N} phones can't break it`);
  process.exit(failures ? 1 : 0);
})();

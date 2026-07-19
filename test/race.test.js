// The Saturday-morning scramble: two managers sign DIFFERENT trough players in
// the same instant. Whole-array writes mean last-write-wins — do both survive?
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
let failures = 0;
const check = (l, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${d ? ' — ' + d : ''}`); if (!ok) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  await p.goto('http://localhost:8142/', { waitUntil: 'networkidle2' });
  await p.waitForFunction('!!window.WCSync', { timeout: 8000 });
  return p;
}

(async () => {
  curl(['-X', 'PUT', '-d', '"setup"', dbUrl(`leagues/${LEAGUE}/phase`), ...CURL_AUTH]);
  curl(['-X', 'DELETE', dbUrl(`leagues/${LEAGUE}`), ...CURL_AUTH]);
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new', protocolTimeout: 240000,
    args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  });
  const A = await newClient(browser, 1);
  await sleep(2000);
  // fast local draft on A, publish once — league straight to season
  await A.evaluate(() => {
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
  const B = await newClient(browser, 2);
  const C = await newClient(browser, 5);
  await sleep(1500);

  // both pick their targets (different free players), fire in the same instant
  // the sign path the app now uses: transactional append with in-txn checks
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

  // 1. different players, same instant → both land
  const [b1, c1] = await Promise.all([sign(B, 2, 0), sign(C, 5, 1)]);
  await sleep(2000);
  let cloudArr = Object.values(JSON.parse(curl([dbUrl(`leagues/${LEAGUE}/transfers`), ...CURL_AUTH])) || {});
  check('simultaneous trough signings of DIFFERENT players both survive',
    b1.ok && c1.ok && cloudArr.some(t => t && t.inId === b1.inId) && cloudArr.some(t => t && t.inId === c1.inId),
    `cloud holds ${cloudArr.length} transfers`);

  // 2. THE SAME player, same instant → exactly one winner, loser told no
  const [b2, c2] = await Promise.all([sign(B, 2, 5), sign(C, 5, 5)]);
  await sleep(2000);
  cloudArr = Object.values(JSON.parse(curl([dbUrl(`leagues/${LEAGUE}/transfers`), ...CURL_AUTH])) || {});
  const winners = cloudArr.filter(t => t && t.inId === b2.inId).length;
  check('same-player scramble: exactly ONE winner, loser politely refused',
    winners === 1 && (b2.ok !== c2.ok),
    `winners=${winners}, B ok=${b2.ok}, C ok=${c2.ok}`);

  // 3. simultaneous trade proposals → both offers survive as pending
  const prop = (page, from, to) => page.evaluate(async (f, t2) => {
    const give = managerSquad(f).filter(p => p.pos === 'DF').pop().id;
    const get = managerSquad(t2).filter(p => p.pos === 'DF').pop().id;
    proposeTrade(f, t2, [give], [get], '');
    await new Promise(r => setTimeout(r, 1200));
    return true;
  }, from, to);
  await Promise.all([prop(B, 2, 1), prop(C, 5, 1)]);
  await sleep(2000);
  const tradesCloud = Object.values(JSON.parse(curl([dbUrl(`leagues/${LEAGUE}/trades`), ...CURL_AUTH])) || {});
  check('simultaneous trade proposals BOTH land',
    tradesCloud.filter(t => t && t.status === 'pending').length === 2, `cloud holds ${tradesCloud.length} trades`);

  await browser.close();
  curl(['-X', 'PUT', '-d', '"setup"', dbUrl(`leagues/${LEAGUE}/phase`), ...CURL_AUTH]);
  curl(['-X', 'DELETE', dbUrl(`leagues/${LEAGUE}`), ...CURL_AUTH]);
  console.log(failures ? '\nRACE CONFIRMED — writes are lossy' : '\nNO RACE — appends are safe');
  process.exit(failures ? 1 : 0);
})();

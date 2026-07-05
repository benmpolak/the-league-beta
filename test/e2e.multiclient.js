// THE fundamental-gameplay test: three real browsers, three identities, the
// REAL Firebase RTDB under a throwaway league key. Draft night, turn
// enforcement, deadline autopick single-firing, contested waivers, trough
// signings, trades, and cross-device gameweek scoring — end to end.
const puppeteer = require('/Users/benpolak/the-league/node_modules/puppeteer-core');
const fs = require('fs');
const { execFileSync } = require('child_process');
const curl = (args) => execFileSync('curl', ['-s', ...args], { encoding: 'utf8' });

const LEAGUE = 'the-league-e2e-test';
const DB = 'https://calciopoli-wc26-default-rtdb.europe-west1.firebasedatabase.app';
const SITE = 'http://localhost:8140';
let failures = 0;
const check = (l, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${d ? ' — ' + d : ''}`); if (!ok) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wipeTestLeague() {
  // the rules only allow deleting a league whose phase is 'setup' — flip, then wipe
  curl(['-X', 'PUT', '-d', '"setup"', `${DB}/leagues/${LEAGUE}/phase.json`]);
  curl(['-X', 'DELETE', `${DB}/leagues/${LEAGUE}.json`]);
}

async function newClient(browser, whoami) {
  const ctx = await browser.createBrowserContext(); // isolated localStorage per identity
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log(`[pageerror mgr${whoami}]`, e.message.slice(0, 120)));
  p.on('console', m => { const t = m.text(); if (/failed|denied|permission|warn/i.test(t)) console.log(`[console mgr${whoami}]`, t.slice(0, 200)); });
  p.on('dialog', d => d.accept());
  await p.setRequestInterception(true);
  const syncSrc = fs.readFileSync('/Users/benpolak/the-league/js/sync.js', 'utf8')
    .replace("const LEAGUE = 'the-league-2627';", `const LEAGUE = '${LEAGUE}';`);
  p.on('request', req => {
    if (req.url().includes('js/sync.js')) {
      return req.respond({ contentType: 'application/javascript', body: syncSrc });
    }
    req.continue();
  });
  await p.evaluateOnNewDocument(id => {
    localStorage.clear();
    localStorage.setItem('tl2627-whoami', String(id));
  }, whoami);
  await p.goto(SITE, { waitUntil: 'networkidle2' });
  try { await p.waitForFunction('!!window.WCSync', { timeout: 8000 }); } catch {}
  return p;
}

(async () => {
  await wipeTestLeague();
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    protocolTimeout: 300000,
    args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  });

  // A = Ben (commissioner, id 1) · B = Toby (id 2) · C = Tussie (id 5)
  const A = await newClient(browser, 1);
  await sleep(2500); // A sees the empty cloud and republishes fresh state
  const B = await newClient(browser, 2);
  const C = await newClient(browser, 5);
  await sleep(1500);

  check('all three clients online against the test league',
    await A.evaluate(() => netOn()) && await B.evaluate(() => netOn()) && await C.evaluate(() => netOn()));

  // ---------- DRAFT NIGHT ----------
  // short pick timer so the deadline autopick fires during the test
  await A.evaluate(() => {
    state.settings.pickTimer = 4;
    pushShared('settings/pickTimer', 4);
    save(); render();
    document.querySelector('#startDraftOrdered')?.click();
  });
  await sleep(500);
  await A.evaluate(() => document.querySelectorAll('.overlay').forEach(o => o.remove()));
  try {
    await B.waitForFunction("state.phase === 'draft'", { timeout: 10000, polling: 300 });
  } catch {}
  await B.evaluate(() => document.querySelectorAll('.overlay').forEach(o => o.remove()));
  await C.evaluate(() => document.querySelectorAll('.overlay').forEach(o => o.remove()));
  check('draft start propagates to every device',
    await B.evaluate(() => state.phase === 'draft') && await C.evaluate(() => state.phase === 'draft'));

  // deadline autopick: the app grants 5 minutes' ceremony grace at start, so
  // simulate the per-pick countdown by setting a 3s deadline directly.
  await A.evaluate(() => {
    state.draft.deadline = Date.now() + 3000;
    pushShared('draft/deadline', state.draft.deadline);
    save(); render();
  });
  await sleep(8000);
  const afterClock = await A.evaluate(() => ({
    n: state.draft.picks.length,
    seq: state.draft.picks.map(pk => pk.managerId).join(','),
    expect: state.draft.order.slice(0, state.draft.picks.length).join(','),
    unique: new Set(state.draft.picks.map(pk => pk.playerId)).size === state.draft.picks.length,
  }));
  check('deadline autopick fires cleanly (sequential, no duplicates, single firer)',
    afterClock.n >= 1 && afterClock.n <= 3 && afterClock.seq === afterClock.expect && afterClock.unique,
    `picks=${afterClock.n} seq=${afterClock.seq}`);

  // stop the clock for controlled play
  await A.evaluate(() => { state.settings.pickTimer = 0; pushShared('settings/pickTimer', 0); save(); render(); });
  await sleep(800);

  // turn enforcement on a REAL synced league: B acts when it isn't his turn
  const turnBlock = await B.evaluate(() => {
    const before = state.draft.picks.length;
    const mid = currentManagerId();
    if (mid === 2) return { skip: true };
    const someone = PLAYERS.filter(pl => !draftedIds().has(pl.id) && canPick(mid, pl))[0];
    if (!someone) return { skip: true };
    makePick(someone.id); // unforced — must bounce
    const btn = document.querySelector('[data-pick]:not([disabled])');
    return { skip: false, before, after: state.draft.picks.length, poolButtonsLocked: !btn };
  });
  await sleep(600);
  const turnBlockConfirm = await A.evaluate(n => state.draft.picks.length === n, turnBlock.before ?? 0);
  check("B cannot pick on someone else's turn (engine + pool buttons)",
    turnBlock.skip || (turnBlock.before === turnBlock.after && turnBlock.poolButtonsLocked && turnBlockConfirm));

  // march the draft to B's turn via real commissioner force-picks, then B
  // autopicks from HIS ranked list and it lands on every device
  const marchErr = await A.evaluate(async () => {
    try {
      const sleep2 = ms => new Promise(r => setTimeout(r, ms));
      let guard = 0;
      while (currentManagerId() !== 2 && state.phase === 'draft' && guard++ < 40) {
        const mid = currentManagerId();
        const best = PLAYERS.filter(pl => !draftedIds().has(pl.id) && canPick(mid, pl)).sort((a, b) => rating(b) - rating(a))[0];
        if (!best) return 'no pickable player for mid ' + mid;
        makePick(best.id, true);
        await sleep2(500);
      }
      return null;
    } catch (e) { return e.message + ' | picks=' + state.draft.picks.length + ' onclock=' + currentManagerId(); }
  });
  if (marchErr) console.log('  [march]', marchErr);
  try { await B.waitForFunction('currentManagerId() === 2', { timeout: 10000, polling: 300 }); } catch {}
  const bAuto = await B.evaluate(async () => {
    const sleep2 = ms => new Promise(r => setTimeout(r, ms));
    const cheap = PLAYERS.filter(pl => !draftedIds().has(pl.id) && pl.pos === 'MF' && canPick(2, pl)).sort((a, b) => rating(a) - rating(b))[0];
    setAutolist(2, [cheap.id]);
    document.querySelector('#autoPick')?.click();
    await sleep2(800);
    const mine = managerSquad(2).map(p => p.id);
    return { got: mine.includes(cheap.id), pid: cheap.id };
  });
  let aSees = false;
  try {
    await A.waitForFunction(pid => managerSquad(2).some(p => p.id === pid), { timeout: 10000, polling: 300 }, bAuto.pid);
    aSees = true;
  } catch {}
  check("B's own autopick uses his list and propagates to A", bAuto.got && aSees);

  // bulk-complete the draft from the commissioner's console (real txns)
  console.log('  … bulk-drafting the remaining picks over live Firebase (this takes ~40s)');
  const bulkErr = await A.evaluate(async () => {
    try {
      const sleep2 = ms => new Promise(r => setTimeout(r, ms));
      let guard = 0;
      while (state.phase === 'draft' && guard++ < 400) {
        document.querySelectorAll('.overlay').forEach(o => o.remove());
        const mid = currentManagerId();
        const best = PLAYERS.filter(pl => !draftedIds().has(pl.id) && canPick(mid, pl)).sort((a, b) => rating(b) - rating(a))[0];
        if (!best) return 'no pickable player for mid ' + mid;
        makePick(best.id, true);
        await sleep2(200);
      }
      return null;
    } catch (e) { return e.message; }
  });
  if (bulkErr) console.log('  [bulk]', bulkErr);
  try { await B.waitForFunction("state.phase === 'season'", { timeout: 20000, polling: 500 }); } catch {}
  const seasonEverywhere = await Promise.all([A, B, C].map(p => p.evaluate(() => state.phase === 'season' && state.managers.every(m => managerSquad(m.id).length === 14))));
  check('draft completes: season live + full legal squads on ALL devices', seasonEverywhere.every(Boolean));

  // ---------- GAMEWEEK SCORING (real stats feed, cross-device agreement) ----------
  await Promise.all([A, B].map(p => p.evaluate(() => syncNow(false))));
  await sleep(4000);
  const scoreA = await A.evaluate(() => ({ gw10: gwManagerPoints(1, 10), top: h2hStandings(false)[0]?.id, pts: h2hStandings(false)[0]?.pts }));
  const scoreB = await B.evaluate(() => ({ gw10: gwManagerPoints(1, 10), top: h2hStandings(false)[0]?.id, pts: h2hStandings(false)[0]?.pts }));
  check('gameweek scores and table IDENTICAL on different devices',
    scoreA.gw10 === scoreB.gw10 && scoreA.top === scoreB.top && scoreA.pts === scoreB.pts,
    `gw10=${scoreA.gw10}/${scoreB.gw10}, leader ${scoreA.top}:${scoreA.pts} vs ${scoreB.top}:${scoreB.pts}`);

  // ---------- WAIVERS: contested claim, correct priority, drops to waivers ----------
  const target = await A.evaluate(() => {
    const owned = ownedIdsAt(currentGwIndex());
    return PLAYERS.filter(pl => !owned.has(pl.id) && pl.pos === 'FW').sort((a, b) => rating(b) - rating(a))[0].id;
  });
  const dropB = await B.evaluate(t => { const out = managerSquad(2).filter(p => p.pos === 'FW').pop().id; setClaims(2, [{ in: t, out }]); return out; }, target);
  const dropC = await C.evaluate(t => { const out = managerSquad(5).filter(p => p.pos === 'FW').pop().id; setClaims(5, [{ in: t, out }]); return out; }, target);
  await sleep(1200);
  const expectWinner = await A.evaluate(() => {
    const order = waiverOrder(currentGwIndex());
    return order.indexOf(2) < order.indexOf(5) ? 2 : 5; // earlier in queue wins
  });
  const wDebug = await A.evaluate(t => ({
    gw: currentGwIndex(),
    claimKeys: Object.keys(state.claims || {}),
    atGw: JSON.stringify(state.claims?.[currentGwIndex()] || null).slice(0, 200),
    targetFree: !ownedIdsAt(currentGwIndex()).has(t),
    queueHead: waiverOrder(currentGwIndex()).slice(0, 4),
  }), target);
  console.log('  [waiver-pre]', JSON.stringify(wDebug));
  const wRun = await A.evaluate(async t => {
    const t0 = toast; let msg = '';
    toast = m => { msg = m; t0(m); };
    const claimOfB = state.claims[currentGwIndex()]?.[2]?.[0];
    const pre = {
      bHasOut: claimOfB ? managerSquad(2).some(x => x.id === claimOfB.out) : null,
      inFree: claimOfB ? !ownedIdsAt(currentGwIndex()).has(claimOfB.in) : null,
      shape: claimOfB ? squadShapeOk([...squadAt(2, currentGwIndex()).filter(x => x.id !== claimOfB.out), PLAYER_BY_ID[claimOfB.in]]) : null,
    };
    processWaivers(true);
    toast = t0;
    const n0 = state.transfers.length;
    return await new Promise(res => setTimeout(() => {
      const n1 = state.transfers.length;
      setTimeout(() => res({ msg, pre, n0, n300: n1, n1200: state.transfers.length }), 900);
    }, 300));
  }, target);
  console.log('  [waiver-run]', JSON.stringify(wRun));
  await sleep(1500);
  console.log('  [cloud transfers]', curl([`${DB}/leagues/${LEAGUE}/transfers.json`]).slice(0, 300));
  console.log('  [A local transfers]', await A.evaluate(() => JSON.stringify(state.transfers).slice(0, 300)));
  console.log('  [B local transfers]', await B.evaluate(() => JSON.stringify(state.transfers).slice(0, 300)));
  const waiverResult = await A.evaluate(t => {
    const owner = state.managers.find(m => managerSquad(m.id).some(p => p.id === t));
    const wv = state.transfers.filter(x => x.waiver);
    return { owner: owner?.id, waiverTransfers: wv.length, sizes: state.managers.map(m => managerSquad(m.id).length) };
  }, target);
  const loserSees = await (expectWinner === 2 ? C : B).evaluate(t =>
    !managerSquad(whoami).some(p => p.id === t) && myClaims(whoami).length === 0, target);
  check('contested waiver: correct priority wins, loser skipped, squads legal',
    waiverResult.owner === expectWinner && waiverResult.waiverTransfers === 1 && waiverResult.sizes.every(s => s === 14) && loserSees,
    `winner=${waiverResult.owner} expected=${expectWinner}`);
  const droppedOnWaivers = await B.evaluate((dB, dC, win) => onWaivers(PLAYER_BY_ID[win === 2 ? dB : dC]), dropB, dropC, expectWinner);
  check("winner's dropped player is back on waivers", droppedOnWaivers);

  // ---------- TROUGH: instant sign with drop, seen everywhere ----------
  const trough = await C.evaluate(() => {
    const cur = currentGwIndex();
    const owned = ownedIdsAt(cur);
    const inP = PLAYERS.filter(pl => !owned.has(pl.id) && !onWaivers(pl) && pl.pos === 'MF').sort((a, b) => rating(b) - rating(a))[0];
    if (!inP) return { skip: true };
    const outId = managerSquad(5).filter(p => p.pos === 'MF').pop().id;
    if (!squadShapeOk([...squadAt(5, cur).filter(x => x.id !== outId), inP])) return { skip: true };
    state.transfers.push({ managerId: 5, outId, inId: inP.id, gw: cur, n: state.transfers.length + 1, t: Date.now() });
    pushShared('transfers', state.transfers);
    save(); render();
    return { skip: false, inId: inP.id, outId };
  });
  let troughSeen = trough.skip;
  if (!trough.skip) {
    try {
      await A.waitForFunction(pid => managerSquad(5).some(p => p.id === pid), { timeout: 10000, polling: 300 }, trough.inId);
      troughSeen = await A.evaluate(o => !managerSquad(5).some(p => p.id === o) && managerSquad(5).length === 14, trough.outId);
    } catch {}
  }
  check('trough signing (in/out) lands on every device, squad stays 14', troughSeen);

  // ---------- TRADE: propose on B, accept on C, verified on A ----------
  const tradeIds = await B.evaluate(() => {
    const give = managerSquad(2).filter(p => p.pos === 'DF').pop().id;
    const get = managerSquad(5).filter(p => p.pos === 'DF').pop().id;
    proposeTrade(2, 5, [give], [get], 'loan him back by GW30, obviously');
    return { give, get };
  });
  try { await C.waitForFunction("toArr(state.trades).some(t => t.status === 'pending' && t.to === 5)", { timeout: 10000, polling: 300 }); } catch {}
  await C.evaluate(() => {
    const t = toArr(state.trades).find(x => x.status === 'pending' && x.to === 5);
    if (t) respondTrade(t.id, true);
  });
  let tradeOk = false;
  try {
    await A.waitForFunction(ids => managerSquad(5).some(p => p.id === ids.give) && managerSquad(2).some(p => p.id === ids.get),
      { timeout: 10000, polling: 300 }, tradeIds);
    tradeOk = await A.evaluate(() => toArr(state.covenants).some(c => c.text.includes('loan him back')));
  } catch {}
  check('trade: proposed on B, accepted on C, swap + covenant visible on A', tradeOk);

  // ---------- RESET RITUAL + CLEANUP ----------
  await A.evaluate(() => window.WCSync.set('phase', 'setup').then(() => window.WCSync.setRoot(null)));
  await sleep(1500);
  const gone = JSON.parse(curl([`${DB}/leagues/${LEAGUE}.json`]));
  check('reset ritual wipes the test league (rules permit via setup)', gone === null);

  await browser.close();
  await wipeTestLeague();
  console.log(failures ? `\n${failures} FAILURES` : '\nMULTI-CLIENT E2E CLEAN — the fundamentals hold over real Firebase');
  process.exit(failures ? 1 : 0);
})();

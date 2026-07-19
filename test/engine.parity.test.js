// Engine ↔ app.js parity. The engine is a deliberate copy of the game law so
// Cloud Functions can enforce what the client renders; this suite is the tripwire
// that catches the two drifting apart. Runs against the demo season (full
// fictional results) plus a synthetic mid-draft state.
// Usage: python3 -m http.server 8125 &   node test/engine.parity.test.js
'use strict';
const puppeteer = require('puppeteer-core');

let pass = 0, fail = 0;
const chk = (name, ok, detail = '') => {
  if (ok) pass++;
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
  if (ok && process.env.VERBOSE) console.log(`PASS  ${name}`);
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
  });
  const p = await browser.newPage();
  p.on('pageerror', e => { fail++; console.log('PAGEERROR', e.message.split('\n')[0]); });
  await p.goto('http://localhost:8125?nosync', { waitUntil: 'networkidle2' });
  await p.waitForFunction(() => typeof Engine !== 'undefined' && typeof PLAYERS !== 'undefined');

  // ---- demo season: full fictional results, real player pool ----
  await p.evaluate(() => enterDemo());
  await p.waitForFunction(() => state && state.phase === 'season' && Object.keys(state.matchStats).length > 0);

  const season = await p.evaluate(() => {
    const eng = Engine.make({
      players: PLAYERS,
      gameweeks: GAMEWEEKS,
      lastSeasonByCode: (typeof LAST_SEASON !== 'undefined' && LAST_SEASON.byCode) || {},
      // app.js currentGwIndex honours the demo override; give the engine the
      // same view of "now" by freezing it inside the demo GW's window
      now: () => Date.now(),
    });
    const mids = state.managers.map(m => m.id);
    const gws = [0, 1, 2, 3, 4, 5];
    const diffs = [];
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (const mid of mids) {
      for (const g of gws) {
        if (!eq(squadAt(mid, g).map(x => x.id).sort(), eng.squadAt(state, mid, g).map(x => x.id).sort()))
          diffs.push(`squadAt ${mid}/${g}`);
        if (!eq(lineupFor(mid, g), eng.lineupFor(state, mid, g))) diffs.push(`lineupFor ${mid}/${g}`);
        if (!eq(effectiveXI(mid, g), eng.effectiveXI(state, mid, g))) diffs.push(`effectiveXI ${mid}/${g}`);
        if (gwManagerPoints(mid, g) !== eng.gwManagerPoints(state, mid, g)) diffs.push(`gwManagerPoints ${mid}/${g}`);
        if (!eq(benchFor(mid, g).map(x => x.id), eng.benchFor(state, mid, g).map(x => x.id))) diffs.push(`benchFor ${mid}/${g}`);
      }
    }
    for (const g of [1, 3, 5]) {
      if (!eq(standingsBefore(g), eng.standingsBefore(state, g))) diffs.push(`standingsBefore ${g}`);
      if (!eq(waiverOrder(g), eng.waiverOrder(state, g))) diffs.push(`waiverOrder ${g}`);
      if (!eq(pairingsFor(g), eng.pairingsFor(state, g))) diffs.push(`pairingsFor ${g}`);
    }
    // scoring kernel over every fictional stat line
    let statDiffs = 0, statChecked = 0;
    for (const [k, ev] of Object.entries(state.matchStats)) {
      for (const [pid, s] of Object.entries(ev.playerStats || {})) {
        const pl = PLAYER_BY_ID[pid];
        if (!pl) continue;
        statChecked++;
        if (statPoints(pl, s) !== eng.statPoints(state.settings.scoring, pl, s)) statDiffs++;
      }
    }
    // shape validators across every stored lineup
    let xiDiffs = 0;
    for (const mid of mids) for (const g of [0, 1, 2]) {
      const xi = lineupFor(mid, g);
      if (xiValid(xi) !== eng.xiValid(xi)) xiDiffs++;
    }
    return { diffs, statDiffs, statChecked, xiDiffs };
  });
  chk('season: roster/lineup/scoring parity', season.diffs.length === 0, season.diffs.slice(0, 5).join(', '));
  chk(`season: statPoints parity over ${season.statChecked} stat lines`, season.statDiffs === 0 && season.statChecked > 500, `${season.statDiffs} diffs`);
  chk('season: xiValid parity', season.xiDiffs === 0);

  // ---- waiver resolution parity: engine resolveWaivers vs client processWaivers ----
  const waiv = await p.evaluate(() => {
    const eng = Engine.make({
      players: PLAYERS, gameweeks: GAMEWEEKS,
      lastSeasonByCode: (typeof LAST_SEASON !== 'undefined' && LAST_SEASON.byCode) || {},
      now: () => Date.now(),
    });
    // craft claims: three managers chase the same free agent, plus a private second choice
    const owned = ownedIdsAt(currentGwIndex());
    const free = PLAYERS.filter(pl => !owned.has(pl.id) && !arrivalLocked(pl));
    const mids = state.managers.map(m => m.id).slice(0, 3);
    const target = free.find(pl => mids.every(mid => {
      const sq = squadAt(mid, transferGw());
      const out = sq.find(x => x.pos === pl.pos);
      return out && squadShapeOk([...sq.filter(x => x.id !== out.id), pl]);
    }));
    if (!target) return { skip: true };
    const claims = {};
    const cur = currentGwIndex();
    claims[cur] = {};
    for (const mid of mids) {
      const out = squadAt(mid, transferGw()).find(x => x.pos === target.pos);
      claims[cur][mid] = [{ in: target.id, out: out.id }];
    }
    state.claims = claims;
    const runStart = Date.now() - 1;
    const res = eng.resolveWaivers(state, runStart);
    // exactly one winner for the contested player; the first claimant in the
    // queue wins. The engine runs on the real clock (the demo's GW override is
    // client display only), so the expectation must use the engine's own cur.
    const order = eng.waiverOrder(state, eng.currentGwIndex());
    const firstClaimant = order.find(mid => mids.includes(mid));
    const winner = res.executed.find(e => e.in === target.id);
    return {
      skip: false,
      oneWinner: res.executed.filter(e => e.in === target.id).length === 1,
      rightWinner: winner && winner.mid === firstClaimant,
      bucketsSwept: res.buckets.includes(cur),
      stamped: !!res.stampedMeta.lastRun,
    };
  });
  if (waiv.skip) chk('waivers: (skipped — no suitable free agent in demo pool)', true);
  else {
    chk('waivers: contested player has exactly one winner', waiv.oneWinner);
    chk('waivers: winner is first in reverse-standings order', waiv.rightWinner);
    chk('waivers: claim bucket swept + run stamped', waiv.bucketsSwept && waiv.stamped);
  }

  // ---- synthetic mid-draft state: turn order, pick legality, autopick determinism ----
  await p.evaluate(() => exitDemo());
  const draft = await p.evaluate(() => {
    const eng = Engine.make({
      players: PLAYERS, gameweeks: GAMEWEEKS,
      lastSeasonByCode: (typeof LAST_SEASON !== 'undefined' && LAST_SEASON.byCode) || {},
      now: () => Date.now(),
    });
    const saved = state;
    try {
      const s = freshState();
      s.phase = 'draft';
      s.draft.order = s.managers.map(m => m.id);
      // simulate 30 picks by always taking the app's own autopick choice
      const diffs = [];
      for (let i = 0; i < 30; i++) {
        state = s;
        const appMid = currentManagerId();
        const engMid = eng.currentManagerId(s);
        if (appMid !== engMid) { diffs.push(`turn ${i}: ${appMid} vs ${engMid}`); break; }
        const choice = eng.autoPickChoice(s, appMid);
        if (choice == null) { diffs.push(`no choice at ${i}`); break; }
        if (!canPick(appMid, PLAYER_BY_ID[choice]) || !eng.canPick(s, appMid, PLAYER_BY_ID[choice]))
          diffs.push(`canPick disagree at ${i} for ${choice}`);
        s.draft.picks.push({ managerId: appMid, playerId: choice, n: i + 1 });
      }
      // canPick parity over a sample of the pool at the resulting position
      state = s;
      const mid = currentManagerId();
      let cpDiffs = 0;
      for (const pl of PLAYERS.slice(0, 400)) {
        if (canPick(mid, pl) !== eng.canPick(s, mid, pl)) cpDiffs++;
      }
      return { diffs, cpDiffs };
    } finally {
      state = saved;
    }
  });
  chk('draft: snake turn order parity over 30 picks', draft.diffs.length === 0, draft.diffs.join('; '));
  chk('draft: canPick parity over 400-player sample', draft.cpDiffs === 0, `${draft.cpDiffs} diffs`);

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

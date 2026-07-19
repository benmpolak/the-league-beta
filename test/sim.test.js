// Full 26/27 season simulation through the real app — snake draft, 33 H2H
// gameweeks with lineups/bench orders/waivers/trough/trades, the Window Draft,
// auto-subs, the Monzo Cup, and the GW34–36 playoffs. Runs against ?nosync.
// Usage: python3 -m http.server 8125 &  then  node test/sim.test.js
const puppeteer = require('puppeteer-core');
const chromePath = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
  });
  const p = await browser.newPage();
  const pageErrors = [];
  p.on('pageerror', e => pageErrors.push(e.message));
  p.on('dialog', d => d.accept());
  await p.goto('http://localhost:8125?nosync', { waitUntil: 'networkidle2' });

  // ---------- 0. hermetic setup: no background syncs, clean clock ----------
  await p.evaluate(() => {
    syncNow = async () => {};
    state.matchStats = {};
    state.fixtures = [];
    for (const g of GAMEWEEKS) g.finished = false;
    for (const pl of PLAYERS) pl.xp = pl.ppg || 0;
    Date.now = () => new Date('2025-08-10T12:00Z').getTime(); // before GW1
    save(); render();
  });
  check('setup phase renders', await p.evaluate(() => state.phase === 'setup' && !!document.querySelector('#startDraftOrdered')));
  const timerAudit = await p.evaluate(() => ({
    before: draftDeadlineTiming(10_000, 7_000),
    overdue: draftDeadlineTiming(10_000, 19_000),
  }));
  check('draft timer preserves overdue seconds for the on-clock fallback',
    timerAudit.before.left === 3 && timerAudit.before.overBy === 0
      && timerAudit.overdue.left === 0 && timerAudit.overdue.overBy === 9,
    JSON.stringify(timerAudit));
  const demoAudit = await p.evaluate(async () => {
    await enterDemo();
    return { current: currentGwIndex(), selected: teamView.gw, text: document.querySelector('main')?.innerText || '' };
  });
  check('demo opens on its populated GW1 instead of a blank real-world GW',
    demoAudit.current === 0 && demoAudit.selected === 0 && /GW1/.test(demoAudit.text) && !/GW38 — Gameweek 38 \(current\)/.test(demoAudit.text));
  await p.evaluate(() => exitDemo());

  // ---------- 1. draft: ordered start, engine-run 168 picks ----------
  await p.evaluate(() => document.querySelector('#startDraftOrdered').click());
  await new Promise(r => setTimeout(r, 500));
  check('draft starts with 12 in order', await p.evaluate(() =>
    state.phase === 'draft' && state.draft.order.length === 12));
  check('draft-night snapshot taken', await p.evaluate(() =>
    !!state.draftPool?.ids && Object.keys(state.draftPool.ids).length === PLAYERS.length));

  await p.evaluate(() => {
    document.querySelectorAll('.overlay').forEach(o => o.remove()); // ceremony etc.
    let guard = 0;
    while (state.phase === 'draft' && guard++ < 200) {
      const mid = currentManagerId();
      const taken = draftedIds();
      const best = PLAYERS.filter(pl => !taken.has(pl.id) && canPick(mid, pl))
        .sort((a, b) => rating(b) - rating(a))[0];
      state.draft.picks.push({ managerId: mid, playerId: best.id, n: pickNo() + 1 });
      if (pickNo() >= totalPicks()) state.phase = 'season';
    }
    state.view = 'dash';
    save(); render();
  });
  const draftAudit = await p.evaluate(() => {
    const sizes = state.managers.map(m => managerSquad(m.id).length);
    const { posMin, posMax } = state.settings;
    let shapeOk = true;
    for (const m of state.managers) {
      const c = posCount(m.id);
      for (const pos of ['GK', 'DF', 'MF', 'FW']) if (c[pos] < posMin[pos] || c[pos] > posMax[pos]) shapeOk = false;
    }
    const owned = new Set(state.draft.picks.map(x => x.playerId));
    return { sizes, shapeOk, unique: owned.size, phase: state.phase };
  });
  check('all 12 squads have 14', draftAudit.sizes.every(n => n === 14), JSON.stringify(draftAudit.sizes));
  check('squad shapes inside min/max', draftAudit.shapeOk);
  check('168 unique players drafted', draftAudit.unique === 168);
  check('phase flips to season', draftAudit.phase === 'season');

  // ---------- 2. the regular season, GW by GW ----------
  const N_REG = 33;
  for (let gw = 0; gw < N_REG; gw++) {
    const res = await p.evaluate(gw => {
      const out = { checks: {} };
      // clock: middle of this GW's real window
      const mid = (new Date(GAMEWEEKS[gw].from).getTime() + new Date(GAMEWEEKS[gw].to).getTime()) / 2;
      Date.now = () => mid;
      if (currentGwIndex() !== gw) return { err: `currentGwIndex ${currentGwIndex()} != ${gw}` };
      let seed = 4242 + gw;
      const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

      // a few managers fiddle with lineups + bench order before kickoff
      for (const m of state.managers.slice(0, 4)) {
        const xi = lineupFor(m.id, gw);
        (state.lineups[m.id] = state.lineups[m.id] || {})[gw] = xi;
        const bo = benchFor(m.id, gw).map(x => x.id);
        if (bo.length > 1) { const j = 1 + Math.floor(rnd() * (bo.length - 1)); [bo[0], bo[j]] = [bo[j], bo[0]]; setBenchOrder(m.id, gw, bo); }
      }

      // waiver claims: two managers contest the same top free agent
      const owned0 = ownedIdsAt(gw);
      const fa = PLAYERS.filter(x => !owned0.has(x.id) && !arrivalLocked(x)).sort((a, b) => rating(b) - rating(a));
      const order = waiverOrder(gw); // who SHOULD win a contested claim: earliest in this queue
      const [hi, lo] = [order[0], order[order.length - 1]];
      const target = fa.find(x => {
        const dropHi = [...squadAt(hi, gw)].sort((a, b) => rating(a) - rating(b)).find(d => squadShapeOk([...squadAt(hi, gw).filter(q => q.id !== d.id), x]));
        const dropLo = [...squadAt(lo, gw)].sort((a, b) => rating(a) - rating(b)).find(d => squadShapeOk([...squadAt(lo, gw).filter(q => q.id !== d.id), x]));
        return dropHi && dropLo;
      });
      let dropHi, dropLo;
      if (target) {
        dropHi = [...squadAt(hi, gw)].sort((a, b) => rating(a) - rating(b)).find(d => squadShapeOk([...squadAt(hi, gw).filter(q => q.id !== d.id), target]));
        dropLo = [...squadAt(lo, gw)].sort((a, b) => rating(a) - rating(b)).find(d => squadShapeOk([...squadAt(lo, gw).filter(q => q.id !== d.id), target]));
        setClaims(hi, [{ in: target.id, out: dropHi.id }]);
        setClaims(lo, [{ in: target.id, out: dropLo.id }]);
      }

      // the football happens: fabricated final stats for ~88% of owned players
      const ps = {};
      for (const m of state.managers) {
        for (const pl of squadAt(m.id, gw)) {
          if (rnd() < 0.12) continue; // did not play — auto-sub fodder
          const started = rnd() < 0.85;
          const gp = { FW: 0.30, MF: 0.16, DF: 0.05, GK: 0.004 }[pl.pos];
          ps[pl.id] = {
            min: started ? 90 : 25, st: started ? 1 : 0, sub: started ? 0 : 1,
            g: rnd() < gp ? 1 : 0, a: rnd() < 0.14 ? 1 : 0,
            cs: rnd() < 0.32 ? 1 : 0, gc: rnd() < 0.5 ? 1 : 0,
            og: 0, ps: 0, pm: 0, yc: rnd() < 0.12 ? 1 : 0, rc: 0,
            sv: pl.pos === 'GK' ? Math.floor(rnd() * 6) : 0,
          };
        }
      }
      state.matchStats[`gw${GAMEWEEKS[gw].n}`] = { gw, label: GAMEWEEKS[gw].label, date: GAMEWEEKS[gw].from, final: true, playerStats: ps };

      // Tuesday 10:00: the Chairman's clock runs the waivers
      const before = state.transfers.length;
      processWaivers(true);
      if (target) {
        const winner = state.transfers.slice(before).find(t => t.inId === target.id && t.waiver);
        out.checks.contestedToTopOfQueue = !!winner && winner.managerId === hi;
        out.checks.loserGotNothing = !state.transfers.slice(before).some(t => t.inId === target.id && t.managerId === lo);
      } else { out.checks.contestedToTopOfQueue = true; out.checks.loserGotNothing = true; }

      // a trough stroll: someone signs a free agent the moment waivers clear.
      // Transfers take effect from the next unplayed GW (transferGw), so the
      // sign must reckon ownership there — exactly as the real handler does.
      const m6 = state.managers[6].id;
      const tg = transferGw();
      const owned1 = ownedIdsAt(tg);
      const pick = PLAYERS.filter(x => !owned1.has(x.id) && !onWaivers(x) && !arrivalLocked(x)).sort((a, b) => rating(b) - rating(a))
        .find(x => [...squadAt(m6, tg)].some(d => squadShapeOk([...squadAt(m6, tg).filter(q => q.id !== d.id), x])));
      if (pick) {
        const drop = [...squadAt(m6, tg)].sort((a, b) => rating(a) - rating(b)).find(d => squadShapeOk([...squadAt(m6, tg).filter(q => q.id !== d.id), pick]));
        state.transfers.push({ managerId: m6, outId: drop.id, inId: pick.id, gw: tg, n: state.transfers.length + 1, t: Date.now() });
        const lu = state.lineups[m6]?.[tg];
        if (lu) state.lineups[m6][tg] = lu.filter(id => id !== drop.id);
      }
      out.checks.troughSignHappened = !!pick;

      // integrity: every squad 14 and legal, nobody owned twice
      let legal = true;
      const seen = new Set();
      for (const m of state.managers) {
        const sq = squadAt(m.id, gw);
        if (sq.length !== 14 || !squadShapeOk(sq)) legal = false;
        for (const x of sq) { if (seen.has(x.id)) legal = false; seen.add(x.id); }
      }
      out.checks.squadsLegal = legal;

      // scoring self-consistency: manager score = sum of effective XI
      const m0 = state.managers[0].id;
      const eff = effectiveXI(m0, gw);
      out.checks.scoreConsistent = gwManagerPoints(m0, gw) === eff.xi.reduce((t, pid) => t + gwPlayerPoints(pid, gw), 0);
      out.checks.xiFull = eff.xi.length === 11 && xiValid(eff.xi);

      save(); render();
      return out;
    }, gw);
    if (res.err) { check(`GW${gw + 1}`, false, res.err); continue; }
    const bad = Object.entries(res.checks).filter(([, v]) => !v).map(([k]) => k);
    check(`GW${gw + 1} waivers/trough/integrity/scoring`, bad.length === 0, bad.join(','));
  }

  // ---------- 3. engineered auto-sub honouring bench order ----------
  const autoSub = await p.evaluate(() => {
    const gw = 20, mid = state.managers[2].id;
    const key = `gw${GAMEWEEKS[gw].n}`;
    const ps = state.matchStats[key].playerStats;
    const xi = lineupFor(mid, gw);
    const startMF = xi.map(id => PLAYER_BY_ID[id]).find(x => x.pos === 'MF' && ps[x.id]);
    if (!startMF) return { skip: true };
    delete ps[startMF.id]; // he never played
    // both outfield bench players played; order the WORSE one first
    const bench = benchFor(mid, gw).filter(x => x.pos !== 'GK');
    for (const bp of bench) ps[bp.id] = ps[bp.id] || { min: 90, st: 1, sub: 0, g: 0, a: 0, cs: 0, gc: 1, og: 0, ps: 0, pm: 0, yc: 0, rc: 0, sv: 0 };
    const sorted = [...bench].sort((a, b) => rating(a) - rating(b));
    setBenchOrder(mid, gw, [...sorted.map(x => x.id), ...benchFor(mid, gw).filter(x => x.pos === 'GK').map(x => x.id)]);
    const queue = benchFor(mid, gw).filter(x => appearedInGw(x.id, gw));
    const { xi: eff, subs } = effectiveXI(mid, gw);
    const sub = subs.find(s => s.out === startMF.id);
    const firstEligible = queue.find(c => xiValid([...lineupFor(mid, gw).filter(id => id !== startMF.id), c.id]));
    return {
      replaced: !!sub,
      priorityRespected: sub && firstEligible && sub.in === firstEligible.id,
      xiLegal: eff.length === 11 && xiValid(eff),
    };
  });
  check('auto-sub follows bench order, XI stays legal',
    autoSub.skip || (autoSub.replaced && autoSub.priorityRespected && autoSub.xiLegal), JSON.stringify(autoSub));

  // ---------- 4. a trade through the real UI ----------
  await p.evaluate(() => { state.view = 'transfers'; transfersView.tab = 'trades'; whoami = state.managers[0].id; render(); });
  await new Promise(r => setTimeout(r, 250));
  const tradeOk = await p.evaluate(async () => {
    const mid = state.managers[0].id, other = state.managers[1].id;
    const cur = currentGwIndex();
    document.querySelector('#tradeWith').value = other;
    document.querySelector('#tradeWith').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 120));
    // a 2-for-2: pair up two positions present on both sides so shapes hold
    const mineCbs = [...document.querySelectorAll('[data-trside="mine"]')];
    const theirCbs = [...document.querySelectorAll('[data-trside="theirs"]')];
    const byPos = cbs => { const m = {}; for (const c of cbs) { const pos = PLAYER_BY_ID[+c.value].pos; (m[pos] = m[pos] || []).push(c); } return m; };
    const mp = byPos(mineCbs), tp = byPos(theirCbs);
    const posPair = ['MF', 'DF', 'FW'].filter(pos => mp[pos]?.length && tp[pos]?.length).slice(0, 2);
    if (posPair.length < 2) return { skip: true };
    const give = [], get = [];
    for (const pos of posPair) {
      mp[pos][0].checked = true; give.push(+mp[pos][0].value);
      tp[pos][0].checked = true; get.push(+tp[pos][0].value);
    }
    document.querySelector('#tradeGo').click();
    await new Promise(r => setTimeout(r, 150));
    // counterparty accepts
    whoami = other; render();
    await new Promise(r => setTimeout(r, 150));
    const acc = document.querySelector('[data-tracc]');
    if (!acc) return { noOffer: true };
    acc.click();
    await new Promise(r => setTimeout(r, 150));
    whoami = state.managers[0].id;
    const tg = transferGw(); // the trade takes effect from the next unplayed GW
    return {
      twoForTwo: give.length === 2,
      aHasBoth: get.every(pid => squadAt(mid, tg).some(x => x.id === pid)),
      bHasBoth: give.every(pid => squadAt(other, tg).some(x => x.id === pid)),
      sizes: [squadAt(mid, tg).length, squadAt(other, tg).length],
      legal: squadShapeOk(squadAt(mid, tg)) && squadShapeOk(squadAt(other, tg)),
    };
  });
  check('2-for-2 trade via UI swaps both squads, sizes hold',
    tradeOk.skip || (tradeOk.twoForTwo && tradeOk.aHasBoth && tradeOk.bHasBoth && tradeOk.legal && tradeOk.sizes.every(s => s === 14)), JSON.stringify(tradeOk));

  // ---------- 5. the Window Draft (a mid-season January event) ----------
  const wd = await p.evaluate(async () => {
    // put the clock mid-season so signings resolve to a normal in-season GW,
    // not the end-of-season → playoff boundary
    const jan = (new Date(GAMEWEEKS[19].from).getTime() + new Date(GAMEWEEKS[19].to).getTime()) / 2;
    Date.now = () => jan;
    // three new faces arrive after draft night — genuinely unowned both now
    // (so they count as locked) and at the GW the window draft operates on
    const ownedNow = ownedIdsAt(currentGwIndex()), ownedTg = ownedIdsAt(transferGw());
    const newbies = PLAYERS.filter(x => !ownedNow.has(x.id) && !ownedTg.has(x.id)).sort((a, b) => rating(b) - rating(a)).slice(0, 3);
    for (const nb of newbies) delete state.draftPool.ids[nb.id];
    transfersView.tab = 'trough'; render();
    await new Promise(r => setTimeout(r, 100));
    const lockedBefore = lockedArrivals().length;
    const btn = document.querySelector('#wdStart');
    if (!btn) return { noBtn: true, lockedBefore };
    btn.click(); // confirm auto-accepted
    await new Promise(r => setTimeout(r, 150));
    const liveNow = state.windowDraft?.status === 'live';
    const firstUp = wdActor();
    const reversed = state.windowDraft.order[0] === state.draft.order[11];
    // first manager signs an arrival (picking a drop that keeps the squad legal)
    const actor = wdActor();
    const outSel = document.querySelector('#wdOut');
    let signed = false;
    const tg = transferGw(); // window-draft signings apply from the next unplayed GW
    for (const inBtn of document.querySelectorAll('[data-wdin]')) {
      const inP = PLAYER_BY_ID[+inBtn.dataset.wdin];
      const drop = squadAt(actor, tg).find(d => squadShapeOk([...squadAt(actor, tg).filter(q => q.id !== d.id), inP]));
      if (!drop) continue;
      outSel.value = drop.id;
      inBtn.click();
      signed = true;
      break;
    }
    await new Promise(r => setTimeout(r, 150));
    if (!signed) return { noLegalSign: true };
    for (let k = 0; k < 13 && document.querySelector('#wdPass'); k++) {
      document.querySelector('#wdPass').click();
      await new Promise(r => setTimeout(r, 60));
    }
    return {
      lockedBefore, liveNow, reversed, firstUp,
      done: state.windowDraft?.status === 'done',
      unlocked: lockedArrivals().length === 0,
      tagged: state.transfers.some(t => t.windowDraft),
    };
  });
  check('window draft: lock → reverse-order draft → pass-lap → trough release',
    wd.lockedBefore === 3 && wd.liveNow && wd.reversed && wd.done && wd.unlocked && wd.tagged, JSON.stringify(wd));

  // ---------- 6. Monzo Cup recomputed independently ----------
  const cup = await p.evaluate(() => {
    let alive = state.managers.map(m => m.id);
    const CUP = 7;
    let rounds = 0;
    for (let i = CUP; i < 33 && alive.length > 1; i++) {
      if (gwStatus(i) !== 'final') break;
      const scores = alive.map(id => ({ id, pts: gwManagerPoints(id, i) }));
      const min = Math.min(...scores.map(s => s.pts));
      const lowest = scores.filter(s => s.pts === min);
      if (lowest.length === 1) alive = alive.filter(id => id !== lowest[0].id);
      rounds++;
    }
    state.view = 'cup'; render();
    const html = document.querySelector('#main').innerHTML;
    const winner = alive.length === 1 ? teamName(alive[0]) : null;
    return { alive: alive.length, rounds, winner, cardAgrees: winner ? html.includes('last man standing.') && html.includes(winner.replace(/&/g, '&amp;').slice(0, 10)) : html.includes('still standing') };
  });
  check('Monzo Cup eliminations consistent with the card', cup.cardAgrees, `${cup.rounds} rounds, ${cup.alive} alive${cup.winner ? ', winner ' + cup.winner : ''}`);

  // ---------- 7. playoffs: GW34 semis, GW35–36 two-legged final ----------
  for (let gw = 33; gw < 36; gw++) {
    await p.evaluate(gw => {
      const mid = (new Date(GAMEWEEKS[gw].from).getTime() + new Date(GAMEWEEKS[gw].to).getTime()) / 2;
      Date.now = () => mid;
      let seed = 9000 + gw;
      const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
      const ps = {};
      for (const m of state.managers) for (const pl of squadAt(m.id, gw)) {
        if (rnd() < 0.1) continue;
        ps[pl.id] = { min: 90, st: 1, sub: 0, g: rnd() < 0.12 ? 1 : 0, a: rnd() < 0.12 ? 1 : 0, cs: rnd() < 0.3 ? 1 : 0, gc: 0, og: 0, ps: 0, pm: 0, yc: 0, rc: 0, sv: pl.pos === 'GK' ? 3 : 0 };
      }
      state.matchStats[`gw${GAMEWEEKS[gw].n}`] = { gw, label: GAMEWEEKS[gw].label, date: GAMEWEEKS[gw].from, final: true, playerStats: ps };
      save(); render();
    }, gw);
  }
  const po = await p.evaluate(() => {
    Date.now = () => new Date(GAMEWEEKS[36].from).getTime() + 1000;
    const po = playoffState();
    if (!po) return { err: 'playoffState null after GW36' };
    // independent recompute
    const seeds = standingsBefore(33).rows.map(r => r.id).slice(0, 4);
    const semiW = [[seeds[0], seeds[3]], [seeds[1], seeds[2]]].map(([x, y]) => {
      const px = gwManagerPoints(x, 33), py = gwManagerPoints(y, 33);
      return px === py ? (seeds.indexOf(x) < seeds.indexOf(y) ? x : y) : (px > py ? x : y);
    });
    let cx = 0, cy = 0, wx = 0, wy = 0;
    for (const i of [34, 35]) {
      const a = gwManagerPoints(semiW[0], i), b = gwManagerPoints(semiW[1], i);
      cx += a; cy += b;
      if (a > b) wx++; else if (b > a) wy++;
    }
    const champ = wx > wy ? semiW[0] : wy > wx ? semiW[1]
      : cx > cy ? semiW[0] : cy > cx ? semiW[1] : (seeds.indexOf(semiW[0]) < seeds.indexOf(semiW[1]) ? semiW[0] : semiW[1]);
    state.view = 'h2h'; render();
    const html = document.querySelector('#main').innerHTML;
    return {
      seedsMatch: JSON.stringify(po.seeds) === JSON.stringify(seeds),
      semisMatch: JSON.stringify(po.semiWinners) === JSON.stringify(semiW),
      champMatch: po.champion === champ,
      champ: teamName(champ),
      cardShowsChamp: html.includes('champions of The League'),
    };
  });
  check('playoffs: seeds, semi winners and champion all agree with independent recompute',
    !po.err && po.seedsMatch && po.semisMatch && po.champMatch && po.cardShowsChamp, po.err || `champion: ${po.champ}`);

  // ---------- 8. season-end table + analytics sanity ----------
  const finals = await p.evaluate(() => {
    const st = h2hStandings();
    const sane = st.every(r => r.p === 33 && r.w + r.d + r.l === 33 && r.pts === 3 * r.w + r.d);
    const ap = allPlayTable();
    const apSane = Object.values(ap.rows).every(r => r.w + r.d + r.l === 33 * 11);
    const waste = state.managers.every(m => seasonBenchWaste(m.id) >= 0);
    return { sane, apSane, waste, top: st[0].team || st[0].name };
  });
  check('H2H table arithmetic (P=33, pts=3W+D)', finals.sane, `winner of the table: ${finals.top}`);
  check('all-play ledger complete (33×11 games each)', finals.apSane);
  check('bench waste non-negative for all', finals.waste);

  // ---------- 9. every view renders at season end ----------
  for (const v of ['dash', 'draft', 'team', 'transfers', 'h2h', 'cup', 'table', 'fixtures', 'rules', 'settings']) {
    await p.evaluate(v => { state.view = v; render(); }, v);
    await new Promise(r => setTimeout(r, 100));
    const len = await p.$eval('#main', el => el.innerHTML.length);
    // fixtures is legitimately sparse here — the sim runs with no fixture data
    check(`view "${v}" renders`, len > (v === 'fixtures' ? 100 : 400), `${len} chars`);
  }

  check('zero page errors across the whole season', pageErrors.length === 0, pageErrors.slice(0, 3).join(' ; '));
  await browser.close();
  console.log(failures ? `\n${failures} FAILURES` : '\nALL CHECKS PASSED — the season holds.');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });

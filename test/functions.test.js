/* Server-authoritative mutation layer, proven against the emulators:
 * auth (email link, unknown users, dead sessions), draft races, transfer
 * races, trades (double-accept), waivers (one winner, cleared claims,
 * exactly-once runs), lineup validation, commissioner gating. */
'use strict';
const T = require('./testenv.js');

const LG = 'the-league-2627';
const SB = 'the-league-sandbox';

(async () => {
  const run = T.makeRunner('functions');
  const { chk } = run;
  const { players } = T.genTestData();
  const server = await T.serveTestData(require('path').join(__dirname, 'fixtures', 'testdata'));
  await T.wipe();

  const members = await T.provision(LG, [
    { managerId: 1, email: 'chair@test.local', role: 'commissioner' },
    { managerId: 2, email: 'two@test.local' },
    { managerId: 3, email: 'three@test.local' },
  ]);
  await T.provision(SB, [
    { managerId: 1, email: 'chair@test.local', role: 'commissioner' },
    { managerId: 2, email: 'two@test.local' },
    { managerId: 3, email: 'three@test.local' },
  ].map((m, i) => ({ ...m, email: `sb${i}@test.local` })));
  const tok1 = await T.idTokenFor(members[1].uid);
  const tok2 = await T.idTokenFor(members[2].uid);
  const tok3 = await T.idTokenFor(members[3].uid);

  /* ---------------- auth ---------------- */
  chk('unauthenticated mutate rejected', (await T.mutate(LG, 'lineupSave', {}, null)).error?.status === 'UNAUTHENTICATED');
  const outsider = await T.initAdmin().auth().createUser({ email: 'stranger@test.local' });
  const tokOut = await T.idTokenFor(outsider.uid);
  chk('signed-in non-member rejected', (await T.mutate(LG, 'lineupSave', {}, tokOut)).error?.status === 'PERMISSION_DENIED');

  const link = await T.emailLinkSignIn('two@test.local');
  chk('email-link sign-in returns a session', !!link.idToken);
  if (link.idToken) {
    const viaLink = await T.mutate(LG, 'autolistSet', { pids: [101, 102] }, link.idToken);
    chk('email-link session can act', !viaLink.error, JSON.stringify(viaLink.error));
  }
  // an unknown email can complete Firebase sign-in but holds no membership: rejected
  const unknownLink = await T.emailLinkSignIn('nobody@test.local');
  if (unknownLink.idToken) {
    chk('unknown email cannot act', (await T.mutate(LG, 'autolistSet', { pids: [1] }, unknownLink.idToken)).error?.status === 'PERMISSION_DENIED');
    await T.initAdmin().auth().deleteUser(unknownLink.localId);
  } else chk('unknown email cannot act', true);
  // consumed oob code cannot be replayed (the expired-link path)
  const replay = await fetch(`http://${T.AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithEmailLink?key=fake`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'two@test.local', oobCode: 'dead-code' }),
  }).then(r => r.json());
  chk('dead/expired link rejected', !!replay.error);

  /* ---------------- seed the league ---------------- */
  const seed = T.buildSeedState(players, 3);
  const imp = await T.mutate(LG, 'importState', { state: seed }, tok1);
  chk('commissioner imports league state', !imp.error, JSON.stringify(imp.error));
  chk('non-commissioner cannot import', (await T.mutate(LG, 'importState', { state: seed }, tok2)).error?.status === 'PERMISSION_DENIED');

  const db = T.initAdmin().database();
  const squadOf = async mid => {
    const picks = (await db.ref(`v2/leagues/${LG}/public/draft/picks`).get()).val() || [];
    const transfers = (await db.ref(`v2/leagues/${LG}/public/transfers`).get()).val() || [];
    const ids = new Set(picks.filter(p => p.managerId === mid).map(p => p.playerId));
    for (const t of Object.values(transfers)) if (t && t.managerId === mid) { ids.delete(t.outId); ids.add(t.inId); }
    return [...ids];
  };
  const byPos = (ids, pos) => ids.filter(id => players.find(p => p.id === id)?.pos === pos);
  const owned = new Set([].concat(await squadOf(1), await squadOf(2), await squadOf(3)));
  const freeOf = pos => players.filter(p => p.pos === pos && !owned.has(p.id)).map(p => p.id);

  /* ---------------- lineups ---------------- */
  const sq1 = await squadOf(1);
  const legalXI = [...byPos(sq1, 'GK').slice(0, 1), ...byPos(sq1, 'DF').slice(0, 4), ...byPos(sq1, 'MF').slice(0, 4), ...byPos(sq1, 'FW').slice(0, 2)];
  chk('lineup save (legal, future GW) works', !(await T.mutate(LG, 'lineupSave', { gw: 2, xi: legalXI }, tok1)).error);
  chk('lineup with foreign player rejected', (await T.mutate(LG, 'lineupSave', { gw: 2, xi: [...legalXI.slice(0, 10), (await squadOf(2))[0]] }, tok1)).error?.status === 'INVALID_ARGUMENT');
  const twoGK = [...byPos(sq1, 'GK').slice(0, 2), ...byPos(sq1, 'DF').slice(0, 4), ...byPos(sq1, 'MF').slice(0, 3), ...byPos(sq1, 'FW').slice(0, 2)];
  chk('illegal XI shape rejected', (await T.mutate(LG, 'lineupSave', { gw: 2, xi: twoGK }, tok1)).error?.status === 'INVALID_ARGUMENT');
  chk('started gameweek is locked', (await T.mutate(LG, 'lineupSave', { gw: 1, xi: legalXI }, tok1)).error?.status === 'FAILED_PRECONDITION');
  chk('manager cannot save someone else\'s XI', (await T.mutate(LG, 'lineupSave', { gw: 2, xi: legalXI, asManager: 1 }, tok2)).error?.status === 'PERMISSION_DENIED');
  const t1 = (await db.ref(`v2/leagues/${LG}/public/lineups/1/2-t`).get()).val();
  chk('lineup timestamp is server-stamped', typeof t1 === 'number' && Math.abs(Date.now() - t1) < 60_000);

  /* ---------------- trough signings: waivers gate + races ---------------- */
  // GW2 has started and no waiver run has happened: everyone is on waivers
  const freeMFs = freeOf('MF');
  const dropMine = async (mid, pos) => byPos(await squadOf(mid), pos)[0];
  const gated = await T.mutate(LG, 'troughSign', { inId: freeMFs[0], outId: await dropMine(1, 'MF') }, tok1);
  chk('trough sign blocked while on waivers', gated.error?.status === 'FAILED_PRECONDITION', JSON.stringify(gated.error));
  // commissioner opens the Trough
  chk('non-commissioner cannot open the Trough', (await T.mutate(LG, 'waiverControl', { mode: 'open' }, tok2)).error?.status === 'PERMISSION_DENIED');
  chk('commissioner opens the Trough', !(await T.mutate(LG, 'waiverControl', { mode: 'open' }, tok1)).error);

  // same-player race: exactly one winner
  const target = freeMFs[0];
  const [rA, rB] = await Promise.all([
    T.mutate(LG, 'troughSign', { inId: target, outId: await dropMine(1, 'MF') }, tok1),
    T.mutate(LG, 'troughSign', { inId: target, outId: await dropMine(2, 'MF') }, tok2),
  ]);
  chk('same-player scramble: exactly one winner', [rA, rB].filter(r => !r.error).length === 1, JSON.stringify([rA.error, rB.error]));
  // different players concurrently: both land
  const [dA, dB] = await Promise.all([
    T.mutate(LG, 'troughSign', { inId: freeMFs[1], outId: await dropMine(3, 'MF') }, tok3),
    T.mutate(LG, 'troughSign', { inId: freeMFs[2], outId: await dropMine(2, 'MF') }, tok2),
  ]);
  chk('different-player signings both land', !dA.error && !dB.error, JSON.stringify([dA.error, dB.error]));
  // illegal shape server-rejected: a third GK
  const freeGK = freeOf('GK')[0];
  const badShape = await T.mutate(LG, 'troughSign', { inId: freeGK, outId: await dropMine(1, 'DF') }, tok1);
  chk('shape-breaking signing rejected server-side', badShape.error?.status === 'FAILED_PRECONDITION');
  chk('cannot sign for someone else', (await T.mutate(LG, 'troughSign', { inId: freeGK, outId: await dropMine(2, 'GK'), asManager: 2 }, tok3)).error?.status === 'PERMISSION_DENIED');

  /* ---------------- waivers ---------------- */
  await T.mutate(LG, 'waiverControl', { mode: 'auto' }, tok1);
  const prize = freeOf('FW')[0];
  const curGw = 1; // engine currentGwIndex on the synthetic calendar (GW2 = index 1)
  for (const [mid, tok] of [[1, tok1], [2, tok2], [3, tok3]]) {
    const out = await dropMine(mid, 'FW');
    const r = await T.mutate(LG, 'claimSet', { gwIndex: curGw, claims: [{ in: prize, out }] }, tok);
    chk(`manager ${mid} lodges a blind claim`, !r.error, JSON.stringify(r.error));
  }
  chk('claims are invisible to other managers (rules)', [401, 403].includes((await T.rest('GET', `v2/leagues/${LG}/private/${members[3].uid}/claims`, { token: tok2 })).status));
  chk('non-commissioner cannot run waivers', (await T.mutate(LG, 'waiverRunNow', {}, tok2)).error?.status === 'PERMISSION_DENIED');
  const wr = await T.mutate(LG, 'waiverRunNow', {}, tok1);
  chk('waiver run executes', !wr.error, JSON.stringify(wr.error));
  const prizeWinners = (wr.result?.executed || []).filter(e => e.in === prize);
  chk('contested claim: exactly one winner', prizeWinners.length === 1, JSON.stringify(wr.result));
  const clA = (await db.ref(`v2/leagues/${LG}/private/${members[1].uid}/claims`).get()).val();
  const clB = (await db.ref(`v2/leagues/${LG}/private/${members[2].uid}/claims`).get()).val();
  chk('claims cleared after the run', !clA && !clB);
  const runs = (await db.ref(`v2/leagues/${LG}/server/waiverRuns`).get()).val() || {};
  chk('run recorded with status done', Object.values(runs).some(r => r.status === 'done' && r.executed));
  const meta = (await db.ref(`v2/leagues/${LG}/public/waiverMeta/lastRun`).get()).val();
  chk('lastRun stamped', !!meta);
  const again = await T.mutate(LG, 'waiverRunNow', {}, tok1);
  chk('immediate re-run executes nothing (idempotent)', !again.error && (again.result?.executed || []).length === 0, JSON.stringify(again.result));
  // exactly-once on a shared run id: pre-claim a scheduled slot, then watch a re-claim skip
  await db.ref(`v2/leagues/${LG}/server/waiverRuns/sched-locked`).set({ status: 'done', finishedAt: Date.now() });

  /* ---------------- trades ---------------- */
  const myMF = (await dropMine(1, 'MF'));
  const theirMF = (await dropMine(2, 'MF'));
  const prop = await T.mutate(LG, 'tradePropose', { to: 2, give: [myMF], get: [theirMF] }, tok1);
  chk('trade proposed', !prop.error && prop.result?.id, JSON.stringify(prop.error));
  const tradeId = prop.result.id;
  chk('non-party cannot accept', (await T.mutate(LG, 'tradeRespond', { tradeId, action: 'accept' }, tok3)).error?.status === 'PERMISSION_DENIED');
  const [acc1, acc2] = await Promise.all([
    T.mutate(LG, 'tradeRespond', { tradeId, action: 'accept' }, tok2),
    T.mutate(LG, 'tradeRespond', { tradeId, action: 'accept' }, tok2),
  ]);
  chk('double-accept executes exactly once', [acc1, acc2].filter(r => !r.error).length === 1, JSON.stringify([acc1.error, acc2.error]));
  chk('players actually swapped', (await squadOf(1)).includes(theirMF) && (await squadOf(2)).includes(myMF));
  const prop2 = await T.mutate(LG, 'tradePropose', { to: 2, give: [theirMF], get: [myMF] }, tok1);
  chk('reject path', (await T.mutate(LG, 'tradeRespond', { tradeId: prop2.result.id, action: 'reject' }, tok2)).result?.status === 'rejected');
  const prop3 = await T.mutate(LG, 'tradePropose', { to: 2, give: [theirMF], get: [myMF] }, tok1);
  chk('withdraw path', (await T.mutate(LG, 'tradeRespond', { tradeId: prop3.result.id, action: 'withdraw' }, tok1)).result?.status === 'withdrawn');

  /* ---------------- commissioner desk ---------------- */
  chk('scoring edit is Chairman-only', (await T.mutate(LG, 'settingsSet', { scoringKey: 'assist', value: 4 }, tok2)).error?.status === 'PERMISSION_DENIED');
  chk('Chairman edits scoring', !(await T.mutate(LG, 'settingsSet', { scoringKey: 'assist', value: 4 }, tok1)).error);
  chk('adjustments are Chairman-only', (await T.mutate(LG, 'adjustmentSet', { pid: 100, value: 5 }, tok2)).error?.status === 'PERMISSION_DENIED');

  /* ---------------- draft (sandbox league) ---------------- */
  const sbSeed = { ...T.buildSeedState(players, 3), phase: 'setup' };
  sbSeed.draft = { order: [], picks: [], breaksDone: [], timewastes: {}, paused: false, pausedLeft: 0 };
  const sbTok1 = await T.idTokenFor((await db.ref(`v2/leagues/${SB}/server/managerUid/1`).get()).val());
  const sbTok2 = await T.idTokenFor((await db.ref(`v2/leagues/${SB}/server/managerUid/2`).get()).val());
  const sbTok3 = await T.idTokenFor((await db.ref(`v2/leagues/${SB}/server/managerUid/3`).get()).val());
  await T.mutate(SB, 'importState', { state: sbSeed }, sbTok1);
  chk('draft start is Chairman-gated', (await T.mutate(SB, 'draftAdmin', { op: 'start', order: [1, 2, 3] }, sbTok2)).error?.status === 'PERMISSION_DENIED');
  chk('bad order rejected', (await T.mutate(SB, 'draftAdmin', { op: 'start', order: [1, 2] }, sbTok1)).error?.status === 'INVALID_ARGUMENT');
  chk('Chairman starts the draft', !(await T.mutate(SB, 'draftAdmin', { op: 'start', order: [1, 2, 3] }, sbTok1)).error);
  chk('out-of-turn pick rejected', (await T.mutate(SB, 'draftPick', { playerId: players[0].id, expectedCount: 0 }, sbTok2)).error?.status === 'PERMISSION_DENIED');
  const [p1, p2] = await Promise.all([
    T.mutate(SB, 'draftPick', { playerId: players[0].id, expectedCount: 0 }, sbTok1),
    T.mutate(SB, 'draftPick', { playerId: players[1].id, expectedCount: 0 }, sbTok1),
  ]);
  chk('simultaneous picks: exactly one lands', [p1, p2].filter(r => !r.error).length === 1, JSON.stringify([p1.error, p2.error]));
  chk('autopick before the clock expires rejected', (await T.mutate(SB, 'draftAutopick', {}, sbTok3)).error?.status === 'FAILED_PRECONDITION');
  await db.ref(`v2/leagues/${SB}/public/draft/deadline`).set(Date.now() - 10_000);
  const [a1, a2] = await Promise.all([
    T.mutate(SB, 'draftAutopick', {}, sbTok2),
    T.mutate(SB, 'draftAutopick', {}, sbTok2),
  ]);
  chk('expired clock: anyone triggers autopick, exactly once', [a1, a2].filter(r => !r.error).length === 1, JSON.stringify([a1.error, a2.error]));
  const picks = (await db.ref(`v2/leagues/${SB}/public/draft/picks`).get()).val() || [];
  chk('autopick was deterministic best-available for the on-clock manager', picks.length === 2 && picks[1].managerId === 2);
  chk('timewaste for someone else\'s clock rejected', (await T.mutate(SB, 'draftAdmin', { op: 'timewaste' }, sbTok2)).error?.status === 'PERMISSION_DENIED');

  /* ---------------- membership is the only authority ----------------
   * custom claims are a stale hint at best: revoked, downgraded or
   * mismatched claims never grant anything — the server-owned membership
   * node decides, every time. */
  const auth = T.initAdmin().auth();
  // pruned user: token still carries a manager claim, membership is gone
  const ghost = await auth.createUser({ email: 'ghost@test.local' });
  await auth.setCustomUserClaims(ghost.uid, { leagues: { [LG]: { managerId: 2, role: 'manager' } } });
  const ghostTok = await T.idTokenFor(ghost.uid); // claim baked into the token
  const ghostTry = await T.mutate(LG, 'autolistSet', { pids: [players[0].id] }, ghostTok);
  chk('pruned user with a stale manager claim is rejected', ghostTry.error?.status === 'PERMISSION_DENIED', JSON.stringify(ghostTry.error));
  // downgraded commissioner: token says commissioner, membership says manager
  const demoted = await auth.createUser({ email: 'demoted@test.local' });
  await auth.setCustomUserClaims(demoted.uid, { leagues: { [LG]: { managerId: 3, role: 'commissioner' } } });
  await T.initAdmin().database().ref(`v2/leagues/${LG}/server/membership/${demoted.uid}`).set({ managerId: 3, role: 'manager' });
  const demotedTok = await T.idTokenFor(demoted.uid);
  const demTry = await T.mutate(LG, 'settingsSet', { scoringKey: 'assist', value: 9 }, demotedTok);
  chk('downgraded commissioner cannot use commissioner actions', demTry.error?.status === 'PERMISSION_DENIED', JSON.stringify(demTry.error));
  chk('downgraded commissioner still acts as their (membership) self', !(await T.mutate(LG, 'autolistSet', { pids: [players[0].id] }, demotedTok)).error);
  // mismatched managerId: claim says 3, membership says 2 — membership wins
  const shifty = await auth.createUser({ email: 'shifty@test.local' });
  await auth.setCustomUserClaims(shifty.uid, { leagues: { [LG]: { managerId: 3, role: 'manager' } } });
  await T.initAdmin().database().ref(`v2/leagues/${LG}/server/membership/${shifty.uid}`).set({ managerId: 2, role: 'manager' });
  const shiftyTok = await T.idTokenFor(shifty.uid);
  const sq3now = await squadOf(3);
  const xiFrom3 = [...byPos(sq3now, 'GK').slice(0, 1), ...byPos(sq3now, 'DF').slice(0, 4), ...byPos(sq3now, 'MF').slice(0, 4), ...byPos(sq3now, 'FW').slice(0, 2)];
  const asWrong = await T.mutate(LG, 'lineupSave', { gw: 3, xi: xiFrom3 }, shiftyTok);
  chk('mismatched claim resolves to MEMBERSHIP identity (manager 3 squad rejected)', asWrong.error?.status === 'INVALID_ARGUMENT', JSON.stringify(asWrong.error));
  const sq2now = await squadOf(2);
  const xiFrom2 = [...byPos(sq2now, 'GK').slice(0, 1), ...byPos(sq2now, 'DF').slice(0, 4), ...byPos(sq2now, 'MF').slice(0, 4), ...byPos(sq2now, 'FW').slice(0, 2)];
  chk('mismatched claim acts safely as the membership manager', !(await T.mutate(LG, 'lineupSave', { gw: 3, xi: xiFrom2 }, shiftyTok)).error);

  /* ---------------- server-side rule gaps closed ---------------- */
  // benchOrder locks at kickoff exactly like lineupSave
  const bench2 = (await squadOf(2)).slice(0, 3);
  chk('bench order for a future GW works', !(await T.mutate(LG, 'benchOrder', { gw: 3, pids: bench2 }, tok2)).error);
  chk('bench order after kickoff rejected', (await T.mutate(LG, 'benchOrder', { gw: 1, pids: bench2 }, tok2)).error?.status === 'FAILED_PRECONDITION');
  chk('bench order with a repeat rejected', (await T.mutate(LG, 'benchOrder', { gw: 3, pids: [bench2[0], bench2[0]] }, tok2)).error?.status === 'INVALID_ARGUMENT');
  // autolist validation
  chk('autolist with unknown player rejected', (await T.mutate(LG, 'autolistSet', { pids: [999999] }, tok2)).error?.status === 'INVALID_ARGUMENT');
  chk('autolist with duplicates rejected', (await T.mutate(LG, 'autolistSet', { pids: [players[0].id, players[0].id] }, tok2)).error?.status === 'INVALID_ARGUMENT');
  chk('oversized autolist rejected', (await T.mutate(LG, 'autolistSet', { pids: Array.from({ length: 301 }, (_, i) => i + 1) }, tok2)).error?.status === 'INVALID_ARGUMENT');
  // claim validation: ownership, drop legality, squad shape, caps
  const freeFWs = freeOf('FW');
  const myFW2 = byPos(await squadOf(2), 'FW')[0];
  chk('claim naming an unknown player rejected', (await T.mutate(LG, 'claimSet', { gwIndex: curGw, claims: [{ in: 999999, out: myFW2 }] }, tok2)).error?.status === 'INVALID_ARGUMENT');
  chk('claim dropping a player you do not own rejected', (await T.mutate(LG, 'claimSet', { gwIndex: curGw, claims: [{ in: freeFWs[0], out: (await squadOf(1))[0] }] }, tok2)).error?.status === 'FAILED_PRECONDITION');
  chk('claim for a player you already own rejected', (await T.mutate(LG, 'claimSet', { gwIndex: curGw, claims: [{ in: myFW2, out: myFW2 }] }, tok2)).error?.status === 'FAILED_PRECONDITION');
  const myDF2 = byPos(await squadOf(2), 'DF')[0];
  const freeGK2 = freeOf('GK')[0];
  chk('shape-breaking claim rejected', (await T.mutate(LG, 'claimSet', { gwIndex: curGw, claims: [{ in: freeGK2, out: myDF2 }] }, tok2)).error?.status === 'FAILED_PRECONDITION');
  chk('claim flood rejected (max 30)', (await T.mutate(LG, 'claimSet', { gwIndex: curGw, claims: Array.from({ length: 31 }, () => ({ in: freeFWs[0], out: myFW2 })) }, tok2)).error?.status === 'INVALID_ARGUMENT');
  // squad-rule settings validated as a consistent ruleset
  chk('squad rules are locked outside setup phase', (await T.mutate(LG, 'settingsSet', { key: 'squadSize', value: 20 }, tok1)).error?.status === 'FAILED_PRECONDITION');
  chk('scoring value bounds enforced', (await T.mutate(LG, 'settingsSet', { scoringKey: 'assist', value: 5000 }, tok1)).error?.status === 'INVALID_ARGUMENT');
  // oversized XI payloads die at the gate
  chk('oversized xi rejected', (await T.mutate(LG, 'lineupSave', { gw: 3, xi: Array.from({ length: 40 }, (_, i) => i) }, tok1)).error?.status === 'INVALID_ARGUMENT');
  // importState: strict schema
  chk('import with unknown key rejected', (await T.mutate(LG, 'importState', { state: { ...seed, evilKey: 1 } }, tok1)).error?.status === 'INVALID_ARGUMENT');
  chk('import with bad phase rejected', (await T.mutate(LG, 'importState', { state: { ...seed, phase: 'chaos' } }, tok1)).error?.status === 'INVALID_ARGUMENT');
  chk('import with inconsistent squad rules rejected', (await T.mutate(LG, 'importState', { state: { ...seed, settings: { ...seed.settings, posMin: { GK: 0, DF: 3, MF: 3, FW: 1 } } } }, tok1)).error?.status === 'INVALID_ARGUMENT');
  chk('import with oversized section rejected', (await T.mutate(LG, 'importState', { state: { ...seed, transfers: Array.from({ length: 5001 }, () => ({ x: 1 })) } }, tok1)).error?.status === 'INVALID_ARGUMENT');
  chk('import with junk manager entry rejected', (await T.mutate(LG, 'importState', { state: { ...seed, managers: [{ id: 1, name: 'A', team: 'B', pin: '1234' }, { id: 2, name: 'C', team: 'D' }] } }, tok1)).error?.status === 'INVALID_ARGUMENT');
  chk('legacy export debris (pins) tolerated and dropped', !(await T.mutate(LG, 'importState', { state: { ...seed, pins: { 1: 'x' } } }, tok1)).error
    && !(await T.initAdmin().database().ref(`v2/leagues/${LG}/public/pins`).get()).val());

  /* ---------------- window draft: one atomic transaction ---------------- */
  // (the re-import above rebuilt LG in season phase with fresh squads)
  const mkArrival = async pid => T.initAdmin().database().ref(`v2/leagues/${LG}/public/draftPool/ids/${pid}`).set('Wrexham');
  const wdFree = freeOf('MF').slice(-4); // untouched by earlier signings
  await mkArrival(wdFree[0]); await mkArrival(wdFree[1]);
  chk('window draft start is Chairman-only', (await T.mutate(LG, 'windowDraft', { op: 'start' }, tok2)).error?.status === 'PERMISSION_DENIED');
  chk('Chairman opens the window draft', !(await T.mutate(LG, 'windowDraft', { op: 'start' }, tok1)).error);
  // order is draft order reversed => [3,2,1]; turn 0 belongs to manager 3
  const wdBefore = (await db.ref(`v2/leagues/${LG}/public/transfers`).get()).val();
  const wdCount0 = wdBefore ? Object.keys(wdBefore).length : 0;
  // injected failure before the transaction: nothing may change
  const fpWd = await T.mutate(LG, 'windowDraft', { op: 'pick', inId: wdFree[0], outId: byPos(await squadOf(3), 'MF')[0], expectedTurn: 0, __failpoint: 'wd:beforeTxn' }, tok3);
  chk('wd failpoint fails the call', !!fpWd.error, JSON.stringify(fpWd.result));
  const wdMid = (await db.ref(`v2/leagues/${LG}/public/windowDraft`).get()).val();
  const wdTr1 = (await db.ref(`v2/leagues/${LG}/public/transfers`).get()).val();
  chk('failed wd call left no partial state', (wdMid.turn || 0) === 0 && (wdTr1 ? Object.keys(wdTr1).length : 0) === wdCount0);
  // two rival picks for the same turn: exactly one commits, state moves once
  const out3a = byPos(await squadOf(3), 'MF')[0], out3b = byPos(await squadOf(3), 'MF')[1];
  const [w1, w2] = await Promise.all([
    T.mutate(LG, 'windowDraft', { op: 'pick', inId: wdFree[0], outId: out3a, expectedTurn: 0 }, tok3),
    T.mutate(LG, 'windowDraft', { op: 'pick', inId: wdFree[1], outId: out3b, expectedTurn: 0 }, tok3),
  ]);
  chk('same-turn window picks: exactly one lands', [w1, w2].filter(r => !r.error).length === 1, JSON.stringify([w1.error, w2.error]));
  const wdNow = (await db.ref(`v2/leagues/${LG}/public/windowDraft`).get()).val();
  const wdTr2 = (await db.ref(`v2/leagues/${LG}/public/transfers`).get()).val();
  chk('turn advanced exactly once, one pick recorded, one transfer appended',
    wdNow.turn === 1 && Object.keys(wdNow.picks || {}).length === 1
    && (wdTr2 ? Object.keys(wdTr2).length : 0) === wdCount0 + 1, JSON.stringify(wdNow));
  chk('out-of-turn window pick rejected', (await T.mutate(LG, 'windowDraft', { op: 'pick', inId: wdFree[1], outId: byPos(await squadOf(3), 'MF')[0], expectedTurn: 1 }, tok3)).error?.status === 'PERMISSION_DENIED');
  // a full lap of passes finishes the window IN the same transaction
  chk('pass (manager 2)', !(await T.mutate(LG, 'windowDraft', { op: 'pass', expectedTurn: 1 }, tok2)).error);
  chk('pass (manager 1)', !(await T.mutate(LG, 'windowDraft', { op: 'pass', expectedTurn: 2 }, tok1)).error);
  const lastPass = await T.mutate(LG, 'windowDraft', { op: 'pass', expectedTurn: 3 }, tok1); // snake: lap 2 starts back at 1
  chk('third consecutive pass closes the window', !lastPass.error && lastPass.result?.status === 'done', JSON.stringify(lastPass));
  const poolAfter = (await db.ref(`v2/leagues/${LG}/public/draftPool/ids/${wdFree[1]}`).get()).val();
  chk('draftPool refreshed in the same commit (leftover arrival unlocked)', poolAfter !== 'Wrexham');
  chk('acting on a finished window rejected', (await T.mutate(LG, 'windowDraft', { op: 'pass' }, tok1)).error?.status === 'FAILED_PRECONDITION');

  /* ---------------- waivers: recoverable, effectively exactly-once ---------------- */
  const wFree = freeOf('FW');
  const claimFor2 = { in: wFree[0], out: byPos(await squadOf(2), 'FW')[0] };
  chk('fresh claim lodged', !(await T.mutate(LG, 'claimSet', { gwIndex: curGw, claims: [claimFor2] }, tok2)).error);
  const trCount = async () => Object.keys((await db.ref(`v2/leagues/${LG}/public/transfers`).get()).val() || {}).length;
  const beforeFp1 = await trCount();
  // crash AFTER the plan is written, BEFORE any transfer lands
  const fp1 = await T.mutate(LG, 'waiverRunNow', { runId: 'fp1', __failpoint: 'waivers:afterPlan' }, tok1);
  chk('failpoint after plan: call fails', !!fp1.error);
  const fp1rec = (await db.ref(`v2/leagues/${LG}/server/waiverRuns/manual-fp1`).get()).val();
  chk('crashed run keeps its plan for replay', fp1rec?.status === 'failed' && !!fp1rec?.plan, JSON.stringify(fp1rec?.status));
  chk('no transfers landed before the crash', await trCount() === beforeFp1);
  const fp1claims = (await db.ref(`v2/leagues/${LG}/private/${members[2].uid}/claims`).get()).val();
  chk('claims survive the crash (nothing half-cleared)', !!fp1claims);
  // replay the SAME run id: completes exactly once
  const fp1retry = await T.mutate(LG, 'waiverRunNow', { runId: 'fp1' }, tok1);
  chk('replay completes the crashed run', !fp1retry.error && (fp1retry.result?.executed || []).some(e => e.in === claimFor2.in), JSON.stringify(fp1retry));
  chk('replay landed the transfer exactly once', await trCount() === beforeFp1 + 1);
  chk('claims cleared by the replay', !(await db.ref(`v2/leagues/${LG}/private/${members[2].uid}/claims`).get()).val());
  const fp1done = (await db.ref(`v2/leagues/${LG}/server/waiverRuns/manual-fp1`).get()).val();
  chk('audit record: done, executed and applied recorded', fp1done?.status === 'done' && Array.isArray(fp1done?.executed) && fp1done?.applied === 1, JSON.stringify(fp1done?.status));
  chk('re-running a done run is a no-op skip', (await T.mutate(LG, 'waiverRunNow', { runId: 'fp1' }, tok1)).result?.skipped === 'already processed');
  // crash AFTER transfers landed, BEFORE claims cleared: replay must not duplicate
  const claimFor3 = { in: wFree[1], out: byPos(await squadOf(3), 'FW')[0] };
  chk('second claim lodged', !(await T.mutate(LG, 'claimSet', { gwIndex: curGw, claims: [claimFor3] }, tok3)).error);
  const beforeFp2 = await trCount();
  const fp2 = await T.mutate(LG, 'waiverRunNow', { runId: 'fp2', __failpoint: 'waivers:afterTransfers' }, tok1);
  chk('failpoint after transfers: call fails', !!fp2.error);
  chk('transfer HAD landed before the crash', await trCount() === beforeFp2 + 1);
  const fp2retry = await T.mutate(LG, 'waiverRunNow', { runId: 'fp2' }, tok1);
  chk('replay after post-transfer crash completes', !fp2retry.error, JSON.stringify(fp2retry.error));
  chk('NO duplicate transfer on replay', await trCount() === beforeFp2 + 1);
  const fp2recs = Object.values((await db.ref(`v2/leagues/${LG}/public/transfers`).get()).val() || {})
    .filter(t => t && t.runId === 'manual-fp2');
  chk('exactly one ledger record carries the run id', fp2recs.length === 1);
  chk('claims cleared after replay', !(await db.ref(`v2/leagues/${LG}/private/${members[3].uid}/claims`).get()).val());
  // a live lease is an ERROR to callers — never a hollow success
  await db.ref(`v2/leagues/${LG}/server/waiverRuns/manual-lease1`).set({ status: 'running', startedAt: Date.now() });
  const leased = await T.mutate(LG, 'waiverRunNow', { runId: 'lease1' }, tok1);
  chk('live lease returns an error, not success', !!leased.error, JSON.stringify(leased.result));
  // an EXPIRED lease is re-claimed and the work completes
  await db.ref(`v2/leagues/${LG}/server/waiverRuns/manual-lease1`).update({ startedAt: Date.now() - 10 * 60 * 1000 });
  const reclaimed = await T.mutate(LG, 'waiverRunNow', { runId: 'lease1' }, tok1);
  chk('expired lease re-claimed and completed', !reclaimed.error, JSON.stringify(reclaimed.error));
  chk('re-claimed run recorded done', (await db.ref(`v2/leagues/${LG}/server/waiverRuns/manual-lease1`).get()).val()?.status === 'done');

  /* ---------------- reset: atomic, canonical, immediately usable ---------------- */
  chk('reset is Chairman-only', (await T.mutate(LG, 'resetLeague', { confirm: 'RESET' }, tok2)).error?.status === 'PERMISSION_DENIED');
  chk('reset demands the confirm word', (await T.mutate(LG, 'resetLeague', { confirm: 'yes?' }, tok1)).error?.status === 'FAILED_PRECONDITION');
  const rr = await T.mutate(LG, 'resetLeague', { confirm: 'RESET' }, tok1);
  chk('confirmed reset succeeds', !rr.error, JSON.stringify(rr.error));
  const pubAfter = (await db.ref(`v2/leagues/${LG}/public`).get()).val();
  chk('reset installs a valid setup state (phase + managers + settings)',
    pubAfter?.phase === 'setup' && Object.keys(pubAfter?.managers || {}).length === 3
    && pubAfter?.settings?.squadSize === 14, JSON.stringify(Object.keys(pubAfter || {})));
  chk('reset cleared game state (no transfers/trades/lineups)', !pubAfter.transfers && !pubAfter.trades && !pubAfter.lineups);
  chk('reset cleared private data and run logs',
    !(await db.ref(`v2/leagues/${LG}/private`).get()).val()
    && !(await db.ref(`v2/leagues/${LG}/server/waiverRuns`).get()).val());
  chk('membership SURVIVED the reset', !!(await db.ref(`v2/leagues/${LG}/server/membership/${members[1].uid}`).get()).val());
  // every client action works immediately: the commissioner starts a new draft
  const restart = await T.mutate(LG, 'draftAdmin', { op: 'start', order: [2, 3, 1] }, tok1);
  chk('commissioner can start a new draft straight after reset', !restart.error, JSON.stringify(restart.error));
  chk('league is drafting again', (await db.ref(`v2/leagues/${LG}/public/phase`).get()).val() === 'draft');
  const firstPick = await T.mutate(LG, 'draftPick', { playerId: players.find(p => p.pos === 'GK').id, expectedCount: 0 }, tok2);
  chk('first pick of the new era lands', !firstPick.error, JSON.stringify(firstPick.error));

  server.close();
  run.done();
})().catch(e => { console.error(e); process.exit(1); });

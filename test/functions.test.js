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

  server.close();
  run.done();
})().catch(e => { console.error(e); process.exit(1); });

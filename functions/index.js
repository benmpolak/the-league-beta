/* The League — server-authoritative mutation layer (Cloud Functions v2).
 *
 * Every consequential write to the league goes through `mutate` (or the
 * scheduled waiver runner). The actor is ALWAYS derived from the verified
 * auth token — request data never names who is acting. Game legality is
 * enforced with the same engine the client renders with (js/engine.js,
 * copied here at deploy; parity guarded by test/engine.parity.test.js).
 *
 * Data layout (see database.rules.v2.json — clients cannot write ANY of it):
 *   v2/leagues/$l/public/...            world-readable game state
 *   v2/leagues/$l/private/$uid/...      autolist + waiver claims (owner-read)
 *   v2/leagues/$l/server/membership     uid -> {managerId, role}
 *   v2/leagues/$l/server/managerUid     managerId -> uid
 *   v2/leagues/$l/server/waiverRuns     runId -> {status, ...}
 */
'use strict';
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const Engine = require('./engine.js');

setGlobalOptions({ region: 'europe-west1', maxInstances: 5 });
admin.initializeApp();

const LEAGUES = ['the-league-2627', 'the-league-sandbox'];
const CUP_START = 7;
// reference data comes from the deployed site (updated every 15 min by the
// FPL Action) so functions never need redeploying for data
const DATA_BASE = process.env.DATA_BASE_URL || 'https://benmpolak.github.io/the-league';

/* ---------------- reference data (players / gameweeks / stats) ---------------- */
let _ctxCache = null;
async function loadCtx() {
  if (_ctxCache && Date.now() - _ctxCache.at < 5 * 60 * 1000) return _ctxCache;
  const bust = `?t=${Date.now()}`;
  const [dataSrc, histSrc, statsRes] = await Promise.all([
    fetch(`${DATA_BASE}/js/data.js${bust}`).then(r => { if (!r.ok) throw new Error(`data.js ${r.status}`); return r.text(); }),
    fetch(`${DATA_BASE}/js/history25.js${bust}`).then(r => r.ok ? r.text() : 'const LAST_SEASON = {byCode:{}};'),
    fetch(`${DATA_BASE}/data/stats.json${bust}`).then(r => { if (!r.ok) throw new Error(`stats.json ${r.status}`); return r.json(); }),
  ]);
  const { TEAMS, PLAYERS, GAMEWEEKS_RAW } = new Function(`${dataSrc}; return { TEAMS, PLAYERS, GAMEWEEKS_RAW };`)();
  const { LAST_SEASON } = new Function(`${histSrc}; return { LAST_SEASON };`)();
  const gameweeks = GAMEWEEKS_RAW.map(g => ({ n: g.n, label: g.label, from: g.deadline, to: g.to, finished: g.finished }));
  // matchStats in the exact shape the client builds in syncNow()
  const matchStats = {};
  for (const [gwN, gw] of Object.entries(statsRes.gws || {})) {
    const i = +gwN - 1;
    if (!gameweeks[i]) continue;
    matchStats[`gw${gwN}`] = { gw: i, label: gameweeks[i].label, date: gameweeks[i].from, final: !!gw.finished, playerStats: gw.stats || {} };
  }
  const eng = Engine.make({ players: PLAYERS, gameweeks, lastSeasonByCode: LAST_SEASON.byCode || {}, now: () => Date.now() });
  _ctxCache = { at: Date.now(), eng, PLAYERS, TEAMS, gameweeks, matchStats, PLAYER_BY_ID: Object.fromEntries(PLAYERS.map(p => [p.id, p])), feedGenerated: statsRes.generated || null };
  return _ctxCache;
}

/* ---------------- league plumbing ---------------- */
const db = () => admin.database();
function leagueBase(league) {
  if (!LEAGUES.includes(league)) throw new HttpsError('invalid-argument', 'unknown league');
  return `v2/leagues/${league}`;
}
async function actor(req, league) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'sign in first');
  const base = leagueBase(league);
  const uid = req.auth.uid;
  // custom claims are the fast path; the server-owned membership node is truth
  let m = req.auth.token?.leagues?.[league];
  if (!m) m = (await db().ref(`${base}/server/membership/${uid}`).get()).val();
  if (!m || !Number.isInteger(m.managerId)) throw new HttpsError('permission-denied', 'not a manager in this league');
  return { uid, managerId: m.managerId, role: m.role === 'commissioner' ? 'commissioner' : 'manager' };
}
const isCommish = a => a.role === 'commissioner';
// a manager acts for themselves; the commissioner may act for anyone, but only
// by explicitly naming them (the client shows its own override confirm)
function actingManager(a, data) {
  const target = Number.isInteger(data.asManager) ? data.asManager : a.managerId;
  if (target !== a.managerId && !isCommish(a)) throw new HttpsError('permission-denied', 'that is not your team');
  return target;
}

const toArr = x => Array.isArray(x) ? x : (x ? Object.values(x) : []);
function normalizeState(pub, ctx) {
  const s = pub || {};
  s.managers = toArr(s.managers);
  s.settings = s.settings || {};
  s.settings.scoring = { ...Engine.DEFAULT_SCORING, ...(s.settings.scoring || {}) };
  s.settings.posMin = { GK: 1, DF: 3, MF: 3, FW: 1, ...(s.settings.posMin || {}) };
  s.settings.posMax = { GK: 2, DF: 6, MF: 6, FW: 4, ...(s.settings.posMax || {}) };
  s.settings.squadSize = s.settings.squadSize || 14;
  s.draft = s.draft || {};
  s.draft.order = toArr(s.draft.order);
  s.draft.picks = toArr(s.draft.picks);
  s.draft.breaksDone = toArr(s.draft.breaksDone);
  s.draft.timewastes = s.draft.timewastes || {};
  s.transfers = toArr(s.transfers);
  s.trades = toArr(s.trades);
  s.covenants = toArr(s.covenants);
  s.lineups = s.lineups || {};
  for (const mid of Object.keys(s.lineups)) {
    for (const k of Object.keys(s.lineups[mid] || {})) {
      if (!k.endsWith('-t')) s.lineups[mid][k] = toArr(s.lineups[mid][k]);
    }
  }
  s.benchOrders = s.benchOrders || {};
  s.shirtNums = s.shirtNums || {};
  s.tradeBlock = s.tradeBlock || {};
  s.lobus = s.lobus || {};
  s.adjustments = s.adjustments || {};
  s.waiverMeta = s.waiverMeta || { lastRun: null, control: 'auto' };
  s.autolists = {};
  s.claims = {};
  if (s.windowDraft) { s.windowDraft.order = toArr(s.windowDraft.order); s.windowDraft.picks = toArr(s.windowDraft.picks); }
  s.matchStats = ctx.matchStats;
  return s;
}
async function loadState(league, ctx, { withPrivate = false } = {}) {
  const base = leagueBase(league);
  const pub = (await db().ref(`${base}/public`).get()).val();
  if (!pub) throw new HttpsError('failed-precondition', 'league not initialised');
  const s = normalizeState(pub, ctx);
  if (withPrivate) {
    const [privSnap, memSnap] = await Promise.all([
      db().ref(`${base}/private`).get(),
      db().ref(`${base}/server/membership`).get(),
    ]);
    const priv = privSnap.val() || {};
    const mem = memSnap.val() || {};
    for (const [uid, node] of Object.entries(priv)) {
      const mid = mem[uid]?.managerId;
      if (!Number.isInteger(mid)) continue;
      if (node.autolist) s.autolists[mid] = toArr(node.autolist);
      for (const [g, arr] of Object.entries(node.claims || {})) {
        (s.claims[g] = s.claims[g] || {})[mid] = toArr(arr);
      }
    }
  }
  return s;
}
async function uidForManager(league, mid) {
  return (await db().ref(`${leagueBase(league)}/server/managerUid/${mid}`).get()).val();
}
const intArray = (x, name) => {
  const a = toArr(x).map(Number);
  if (a.some(n => !Number.isInteger(n))) throw new HttpsError('invalid-argument', `${name} must be player ids`);
  return a;
};

/* RTDB transactions run their first attempt against an empty local cache
 * (cur === null) even when the node exists. Returning undefined on that pass
 * aborts for good, so every array txn seeds the null pass from the state we
 * already read — if the server disagrees, the txn re-runs with the real value. */
const seeded = (seed, fn) => cur => fn(cur === null ? toArr(seed).map(x => ({ ...x })) : toArr(cur));

/* ---------------- transfer helper: append records with in-txn revalidation ---------------- */
async function appendTransfers(league, state, eng, records, tgw) {
  const ref = db().ref(`${leagueBase(league)}/public/transfers`);
  const res = await ref.transaction(seeded(state.transfers, out => {
    for (const r of records) {
      const owned = eng.ownedIdsGiven(state, out, tgw);
      if (owned.has(r.inId) || !owned.has(r.outId)) return; // sniped — abort whole txn
      out.push({ ...r, n: out.length + 1 });
    }
    return out;
  }));
  if (!res.committed) throw new HttpsError('aborted', 'squad changed underneath you — try again');
  return toArr(res.snapshot.val());
}
// strip a departing player from the target GW's stored lineup, if one exists
async function stripLineup(league, state, mid, tgw, outId) {
  const lu = state.lineups[mid]?.[tgw];
  if (!lu) return;
  await db().ref(`${leagueBase(league)}/public/lineups/${mid}/${tgw}`).set(toArr(lu).filter(id => id !== outId));
}

/* ---------------- the waiver core (shared by schedule + run-now) ---------------- */
async function runWaivers(league, runId, trigger) {
  const base = leagueBase(league);
  const runRef = db().ref(`${base}/server/waiverRuns/${runId}`);
  // exactly-once: claim the run id; a crashed ('failed'/stale 'running') run may be re-claimed
  const claim = await runRef.transaction(cur => {
    if (cur && cur.status === 'done') return;
    if (cur && cur.status === 'running' && Date.now() - (cur.startedAt || 0) < 10 * 60 * 1000) return;
    return { status: 'running', trigger, startedAt: Date.now() };
  });
  if (!claim.committed) return { skipped: 'already processed' };
  try {
    const ctx = await loadCtx();
    if (ctx.feedGenerated && Date.now() - new Date(ctx.feedGenerated).getTime() > 90 * 60 * 1000) {
      throw new Error('stats feed is stale (>90 min) — refusing to run waivers on old scores');
    }
    const eng = ctx.eng;
    const state = await loadState(league, ctx, { withPrivate: true });
    if (state.phase !== 'season') { await runRef.update({ status: 'done', result: 'skipped: not in season', finishedAt: Date.now() }); return { skipped: 'not in season' }; }
    if (trigger === 'schedule' && eng.waiverControl(state) !== 'auto') { await runRef.update({ status: 'done', result: 'skipped: control!=auto', finishedAt: Date.now() }); return { skipped: 'control' }; }
    if (trigger === 'schedule' && !eng.waiverRunDue(state)) { await runRef.update({ status: 'done', result: 'skipped: not due', finishedAt: Date.now() }); return { skipped: 'not due' }; }

    const runStart = Date.now() - 1;
    const res = eng.resolveWaivers(state, runStart);
    if (res.records.length) await appendTransfers(league, state, eng, res.records, res.tgw);

    // clear swept buckets across every member's private node + stamp the run,
    // in one atomic multi-path update
    const mem = (await db().ref(`${base}/server/membership`).get()).val() || {};
    const upd = {};
    upd[`${base}/public/waiverMeta`] = res.stampedMeta;
    for (const uid of Object.keys(mem)) for (const g of res.buckets) upd[`${base}/private/${uid}/claims/${g}`] = null;
    for (const [mid, xi] of Object.entries(res.strippedLineups)) upd[`${base}/public/lineups/${mid}/${res.tgw}`] = xi;
    upd[`${base}/server/waiverRuns/${runId}/status`] = 'done';
    upd[`${base}/server/waiverRuns/${runId}/finishedAt`] = Date.now();
    upd[`${base}/server/waiverRuns/${runId}/executed`] = res.executed;
    await db().ref().update(upd);
    return { executed: res.executed };
  } catch (e) {
    await runRef.update({ status: 'failed', error: String(e.message || e), finishedAt: Date.now() });
    throw e;
  }
}

/* ---------------- action registry ---------------- */
const ACTIONS = {};

/* ----- draft ----- */
ACTIONS.draftPick = async ({ league, a, data, ctx, state, eng }) => {
  if (state.phase !== 'draft') throw new HttpsError('failed-precondition', 'not drafting');
  if (state.draft.paused) throw new HttpsError('failed-precondition', 'draft is paused');
  const onClock = eng.currentManagerId(state);
  if (onClock == null) throw new HttpsError('failed-precondition', 'draft is complete');
  if (a.managerId !== onClock && !isCommish(a)) throw new HttpsError('permission-denied', 'not your pick');
  const player = ctx.PLAYER_BY_ID[data.playerId];
  if (!player) throw new HttpsError('invalid-argument', 'unknown player');
  if (!eng.canPick(state, onClock, player)) throw new HttpsError('failed-precondition', 'illegal pick (position limits or locked arrival)');
  const expected = Number.isInteger(data.expectedCount) ? data.expectedCount : state.draft.picks.length;
  const base = leagueBase(league);
  const res = await db().ref(`${base}/public/draft/picks`).transaction(seeded(state.draft.picks, arr => {
    if (arr.length !== expected) return;
    if (arr.some(p => p.playerId === player.id)) return;
    arr.push({ managerId: onClock, playerId: player.id, n: arr.length + 1 });
    return arr;
  }));
  if (!res.committed) throw new HttpsError('aborted', 'the board moved on');
  const total = toArr(res.snapshot.val()).length;
  const upd = {};
  if (state.settings.pickTimer && total < eng.totalPicks(state)) upd[`${base}/public/draft/deadline`] = Date.now() + state.settings.pickTimer * 1000;
  if (total >= eng.totalPicks(state)) upd[`${base}/public/phase`] = 'season';
  if (Object.keys(upd).length) await db().ref().update(upd);
  return { picked: player.id, total };
};

ACTIONS.draftAutopick = async ({ league, a, data, ctx, state, eng }) => {
  if (state.phase !== 'draft') throw new HttpsError('failed-precondition', 'not drafting');
  if (state.draft.paused) throw new HttpsError('failed-precondition', 'draft is paused');
  const onClock = eng.currentManagerId(state);
  if (onClock == null) throw new HttpsError('failed-precondition', 'draft is complete');
  // anyone signed in may trigger it once the clock has expired (so a sleeping
  // commissioner phone can never stall draft night); the choice is deterministic
  const overdue = state.draft.deadline && Date.now() > state.draft.deadline + 2000;
  if (!overdue && a.managerId !== onClock && !isCommish(a)) throw new HttpsError('failed-precondition', 'clock has not expired');
  const stateWithLists = await loadState(league, ctx, { withPrivate: true });
  const choice = eng.autoPickChoice(stateWithLists, onClock);
  if (choice == null) throw new HttpsError('failed-precondition', 'no legal pick available');
  return ACTIONS.draftPick({ league, a: { ...a, managerId: onClock }, data: { playerId: choice, expectedCount: state.draft.picks.length }, ctx, state, eng });
};

ACTIONS.draftAdmin = async ({ league, a, data, state, eng }) => {
  const base = leagueBase(league);
  const d = `${base}/public/draft`;
  const op = data.op;
  if (op === 'timewaste') {
    if (state.phase !== 'draft') throw new HttpsError('failed-precondition', 'not drafting');
    const onClock = eng.currentManagerId(state);
    if (a.managerId !== onClock && !isCommish(a)) throw new HttpsError('permission-denied', 'not your clock to waste');
    const used = state.draft.timewastes?.[onClock] || 0;
    if (used >= 2) throw new HttpsError('failed-precondition', 'both timewastes burned');
    await db().ref().update({
      [`${d}/timewastes/${onClock}`]: used + 1,
      [`${d}/deadline`]: (state.draft.deadline || Date.now()) + 60 * 1000,
    });
    return { ok: true };
  }
  if (!isCommish(a)) throw new HttpsError('permission-denied', 'Chairman only');
  if (op === 'start') {
    if (state.phase !== 'setup') throw new HttpsError('failed-precondition', 'already started');
    const order = intArray(data.order, 'order');
    const ids = state.managers.map(m => m.id).sort((x, y) => x - y);
    if (JSON.stringify([...order].sort((x, y) => x - y)) !== JSON.stringify(ids)) throw new HttpsError('invalid-argument', 'order must be a permutation of the twelve');
    const ctx2 = await loadCtx();
    await db().ref().update({
      [`${base}/public/phase`]: 'draft',
      [`${d}/order`]: order,
      [`${d}/picks`]: null,
      [`${d}/deadline`]: state.settings.pickTimer ? Date.now() + state.settings.pickTimer * 1000 : null,
      [`${base}/public/draftPool`]: { at: Date.now(), ids: Object.fromEntries(ctx2.PLAYERS.map(p => [p.id, p.club])) },
    });
    return { ok: true };
  }
  if (op === 'pause') { await db().ref().update({ [`${d}/paused`]: true, [`${d}/pausedLeft`]: Math.max(0, (state.draft.deadline || 0) - Date.now()) }); return { ok: true }; }
  if (op === 'resume') { await db().ref().update({ [`${d}/paused`]: false, [`${d}/deadline`]: Date.now() + (state.draft.pausedLeft || (state.settings.pickTimer || 30) * 1000) }); return { ok: true }; }
  if (op === 'breakDone') {
    await db().ref().update({ [`${d}/breaksDone`]: [...state.draft.breaksDone, data.round ?? state.draft.breaksDone.length], [`${d}/deadline`]: Date.now() + (state.settings.pickTimer || 30) * 1000 });
    return { ok: true };
  }
  if (op === 'undo') {
    const res = await db().ref(`${d}/picks`).transaction(seeded(state.draft.picks, arr => { arr.pop(); return arr; }));
    if (!res.committed) throw new HttpsError('aborted', 'undo clashed');
    await db().ref(`${d}/deadline`).set(Date.now() + (state.settings.pickTimer || 30) * 1000);
    return { total: toArr(res.snapshot.val()).length };
  }
  throw new HttpsError('invalid-argument', 'unknown draft op');
};

/* ----- lineups / bench / lists ----- */
ACTIONS.lineupSave = async ({ league, a, data, ctx, state, eng }) => {
  const mid = actingManager(a, data);
  const gw = Number(data.gw);
  if (!Number.isInteger(gw) || gw < 0 || gw >= ctx.gameweeks.length) throw new HttpsError('invalid-argument', 'bad gameweek');
  if (eng.gwHasStarted(gw)) throw new HttpsError('failed-precondition', 'that gameweek has kicked off');
  const xi = intArray(data.xi, 'xi');
  const squadIds = new Set(eng.squadAt(state, mid, gw).map(p => p.id));
  if (!xi.every(id => squadIds.has(id))) throw new HttpsError('invalid-argument', 'XI contains players not in the squad');
  if (!eng.xiValid(xi)) throw new HttpsError('invalid-argument', 'XI shape is illegal');
  await db().ref().update({
    [`${leagueBase(league)}/public/lineups/${mid}/${gw}`]: xi,
    [`${leagueBase(league)}/public/lineups/${mid}/${gw}-t`]: Date.now(), // server clock: no wound-back phones
  });
  return { ok: true };
};

ACTIONS.benchOrder = async ({ league, a, data, state, eng, ctx }) => {
  const mid = actingManager(a, data);
  const gw = Number(data.gw);
  if (!Number.isInteger(gw) || gw < 0 || gw >= ctx.gameweeks.length) throw new HttpsError('invalid-argument', 'bad gameweek');
  const pids = intArray(data.pids, 'pids');
  const squadIds = new Set(eng.squadAt(state, mid, gw).map(p => p.id));
  if (!pids.every(id => squadIds.has(id))) throw new HttpsError('invalid-argument', 'bench order names players not in the squad');
  await db().ref(`${leagueBase(league)}/public/benchOrders/${mid}/${gw}`).set(pids);
  return { ok: true };
};

ACTIONS.autolistSet = async ({ league, a, data }) => {
  const pids = intArray(data.pids, 'pids');
  await db().ref(`${leagueBase(league)}/private/${a.uid}/autolist`).set(pids);
  return { ok: true };
};

ACTIONS.claimSet = async ({ league, a, data, eng }) => {
  const g = Number(data.gwIndex);
  const cur = eng.currentGwIndex();
  if (!Number.isInteger(g) || Math.abs(g - cur) > 1) throw new HttpsError('invalid-argument', 'claims go in the current gameweek bucket');
  const claims = toArr(data.claims).map(c => ({ in: Number(c.in), out: Number(c.out) }));
  if (claims.some(c => !Number.isInteger(c.in) || !Number.isInteger(c.out))) throw new HttpsError('invalid-argument', 'bad claim');
  await db().ref(`${leagueBase(league)}/private/${a.uid}/claims/${g}`).set(claims);
  return { ok: true };
};

/* ----- signings and trades ----- */
ACTIONS.troughSign = async ({ league, a, data, ctx, state, eng }) => {
  const mid = actingManager(a, data);
  if (state.phase !== 'season') throw new HttpsError('failed-precondition', 'season not underway');
  const inP = ctx.PLAYER_BY_ID[data.inId], outP = ctx.PLAYER_BY_ID[data.outId];
  if (!inP || !outP) throw new HttpsError('invalid-argument', 'unknown player');
  if (eng.arrivalLocked(state, inP)) throw new HttpsError('failed-precondition', 'locked until the Window Draft');
  if (eng.onWaiversCheck ? eng.onWaiversCheck(state, inP) : onWaiversServer(state, inP, eng)) throw new HttpsError('failed-precondition', 'player is on waivers — lodge a claim instead');
  const tgw = eng.transferGw();
  if (eng.ownedIdsAt(state, tgw).has(inP.id)) throw new HttpsError('failed-precondition', 'already owned');
  const squad = eng.squadAt(state, mid, tgw);
  if (!squad.some(p => p.id === outP.id)) throw new HttpsError('failed-precondition', 'that player is not yours to drop');
  if (!eng.squadShapeOk(state, [...squad.filter(p => p.id !== outP.id), inP])) throw new HttpsError('failed-precondition', 'squad shape would be illegal');
  await appendTransfers(league, state, eng, [{ managerId: mid, outId: outP.id, inId: inP.id, gw: tgw, t: Date.now() }], tgw);
  await stripLineup(league, state, mid, tgw, outP.id);
  return { ok: true, tgw };
};
// mirror of app.js onWaivers()
function onWaiversServer(state, p, eng) {
  const ctl = eng.waiverControl(state);
  if (ctl === 'open') return false;
  if (ctl === 'closed') return true;
  const cur = eng.currentGwIndex();
  if (eng.gwHasStarted(cur) && eng.lastWaiverRun(state) < new Date(eng.gwFrom(cur)).getTime()) return true;
  for (const t of state.transfers) if (t.outId === p.id && (t.t || 0) > eng.lastWaiverRun(state)) return true;
  return false;
}

ACTIONS.tradePropose = async ({ league, a, data, ctx, state, eng }) => {
  const from = actingManager(a, data);
  const to = Number(data.to);
  if (!state.managers.some(m => m.id === to) || to === from) throw new HttpsError('invalid-argument', 'bad counterparty');
  const give = intArray(data.give, 'give'), get = intArray(data.get, 'get');
  if (!give.length || give.length !== get.length) throw new HttpsError('invalid-argument', 'trades swap the same number each way');
  const tgw = eng.transferGw();
  const mine = eng.squadIdsGiven(state, from, state.transfers, tgw);
  const theirs = eng.squadIdsGiven(state, to, state.transfers, tgw);
  if (!give.every(id => mine.has(id)) || !get.every(id => theirs.has(id))) throw new HttpsError('failed-precondition', 'players not owned by the right sides');
  const offer = {
    id: `t${Date.now()}-${from}`, from, to, give, get,
    terms: String(data.terms || '').slice(0, 400), status: 'pending', t: Date.now(),
  };
  const res = await db().ref(`${leagueBase(league)}/public/trades`).transaction(seeded(state.trades, arr => [...arr, offer]));
  if (!res.committed) throw new HttpsError('aborted', 'try again');
  return { id: offer.id };
};

ACTIONS.tradeRespond = async ({ league, a, data, ctx, state, eng }) => {
  const trade = state.trades.find(t => t.id === data.tradeId);
  if (!trade) throw new HttpsError('not-found', 'no such trade');
  const action = data.action;
  const base = leagueBase(league);
  const mid = a.managerId;
  if (action === 'withdraw' && mid !== trade.from && !isCommish(a)) throw new HttpsError('permission-denied', 'not your offer');
  if ((action === 'accept' || action === 'reject') && mid !== trade.to && !isCommish(a)) throw new HttpsError('permission-denied', 'not your decision');
  if (action === 'reject' || action === 'withdraw') {
    const to = action === 'reject' ? 'rejected' : 'withdrawn';
    await db().ref(`${base}/public/trades`).transaction(seeded(state.trades, arr => {
      const t = arr.find(x => x.id === trade.id);
      if (!t || t.status !== 'pending') return;
      t.status = to;
      return arr;
    }));
    return { status: to };
  }
  if (action !== 'accept') throw new HttpsError('invalid-argument', 'unknown action');
  // phase 1: claim the trade (pending -> executing) so a double-accept is impossible
  const claim = await db().ref(`${base}/public/trades`).transaction(seeded(state.trades, arr => {
    const t = arr.find(x => x.id === trade.id);
    if (!t || t.status !== 'pending') return;
    t.status = 'executing';
    return arr;
  }));
  if (!claim.committed) throw new HttpsError('aborted', 'trade already handled');
  const give = toArr(trade.give).length ? toArr(trade.give) : [trade.give].filter(Boolean);
  const get = toArr(trade.get).length ? toArr(trade.get) : [trade.get].filter(Boolean);
  const tgw = eng.transferGw();
  const finish = status => db().ref(`${base}/public/trades`).transaction(seeded(state.trades, arr => {
    const t = arr.find(x => x.id === trade.id);
    if (t) t.status = status;
    return arr;
  }));
  try {
    // symmetric records, validated inside the transfers txn: each side must own
    // what it gives and not own what it receives, and both shapes must stay legal
    const recs = [];
    give.forEach((pid, i) => {
      recs.push({ managerId: trade.from, outId: pid, inId: get[i], gw: tgw, t: Date.now(), trade: trade.id });
      recs.push({ managerId: trade.to, outId: get[i], inId: pid, gw: tgw, t: Date.now(), trade: trade.id });
    });
    const ref = db().ref(`${base}/public/transfers`);
    const res = await ref.transaction(seeded(state.transfers, out => {
      const fromSquad = eng.squadIdsGiven(state, trade.from, out, tgw);
      const toSquad = eng.squadIdsGiven(state, trade.to, out, tgw);
      if (!give.every(id => fromSquad.has(id)) || !get.every(id => toSquad.has(id))) return;
      const fromAfter = [...fromSquad].filter(id => !give.includes(id)).concat(get).map(id => ctx.PLAYER_BY_ID[id]).filter(Boolean);
      const toAfter = [...toSquad].filter(id => !get.includes(id)).concat(give).map(id => ctx.PLAYER_BY_ID[id]).filter(Boolean);
      if (!eng.squadShapeOk(state, fromAfter) || !eng.squadShapeOk(state, toAfter)) return;
      for (const r of recs) out.push({ ...r, n: out.length + 1 });
      return out;
    }));
    if (!res.committed) { await finish('pending'); throw new HttpsError('failed-precondition', 'squads changed — trade is void for now'); }
    const upd = {};
    for (const side of [{ mid: trade.from, outs: give }, { mid: trade.to, outs: get }]) {
      const lu = state.lineups[side.mid]?.[tgw];
      if (lu) upd[`${base}/public/lineups/${side.mid}/${tgw}`] = toArr(lu).filter(id => !side.outs.includes(id));
    }
    if (trade.terms) {
      const cov = { id: `c${Date.now()}`, from: trade.from, to: trade.to, text: trade.terms, t: Date.now(), gw: eng.currentGwIndex() };
      await db().ref(`${base}/public/covenants`).transaction(seeded(state.covenants, arr => {
        if (!arr.some(c => c.id === cov.id)) arr.push(cov);
        return arr;
      }));
    }
    if (Object.keys(upd).length) await db().ref().update(upd);
    await finish('done');
    return { status: 'done' };
  } catch (e) {
    if (!(e instanceof HttpsError)) await finish('pending').catch(() => {});
    throw e;
  }
};

ACTIONS.covenantAdd = async ({ league, a, data, state }) => {
  const from = actingManager(a, data);
  const to = Number(data.to);
  if (!state.managers.some(m => m.id === to)) throw new HttpsError('invalid-argument', 'bad counterparty');
  const cov = { id: `c${Date.now()}-${from}`, from, to, text: String(data.text || '').slice(0, 400), t: Date.now(), gw: data.gw ?? null };
  await db().ref(`${leagueBase(league)}/public/covenants`).transaction(seeded(state.covenants, arr => [...arr, cov]));
  return { id: cov.id };
};

/* ----- personalia ----- */
ACTIONS.blockToggle = async ({ league, a, data, state, eng }) => {
  const mid = actingManager(a, data);
  const pid = Number(data.pid);
  const squad = eng.squadAt(state, mid, eng.currentGwIndex());
  if (!squad.some(p => p.id === pid)) throw new HttpsError('failed-precondition', 'not your player');
  const cur = toArr(state.tradeBlock[mid]);
  const next = cur.includes(pid) ? cur.filter(x => x !== pid) : [...cur, pid];
  await db().ref(`${leagueBase(league)}/public/tradeBlock/${mid}`).set(next);
  return { listed: next.includes(pid) };
};

ACTIONS.stadiumSet = async ({ league, a, data, state }) => {
  const mid = actingManager(a, data);
  const idx = state.managers.findIndex(m => m.id === mid);
  if (idx < 0) throw new HttpsError('not-found', 'no such manager');
  await db().ref(`${leagueBase(league)}/public/managers/${idx}/stadium`).set(String(data.name || '').slice(0, 60));
  return { ok: true };
};

ACTIONS.shirtNumSet = async ({ league, a, data, state, eng }) => {
  const mid = actingManager(a, data);
  const pid = Number(data.pid), num = data.num == null ? null : Number(data.num);
  if (!eng.squadAt(state, mid, eng.currentGwIndex()).some(p => p.id === pid)) throw new HttpsError('failed-precondition', 'not your player');
  if (num != null && (!Number.isInteger(num) || num < 1 || num > 99)) throw new HttpsError('invalid-argument', 'numbers run 1-99');
  if (num != null && Object.entries(state.shirtNums[mid] || {}).some(([p, n]) => +p !== pid && n === num)) throw new HttpsError('failed-precondition', 'number taken');
  await db().ref(`${leagueBase(league)}/public/shirtNums/${mid}/${pid}`).set(num);
  return { ok: true };
};

ACTIONS.lobusDeclare = async ({ league, a, data, state, eng }) => {
  const mid = actingManager(a, data);
  const pid = Number(data.pid);
  if (!eng.squadAt(state, mid, eng.currentGwIndex()).some(p => p.id === pid)) throw new HttpsError('failed-precondition', 'the Lobus must be one of your own');
  if (state.lobus[mid] && eng.gwHasStarted(0)) throw new HttpsError('failed-precondition', 'the Lobus is declared for the season');
  await db().ref(`${leagueBase(league)}/public/lobus/${mid}`).set(pid);
  return { ok: true };
};

/* ----- Ham Cup ----- */
ACTIONS.hamEnter = async ({ league, a, data, state, eng, ctx }) => {
  const mid = actingManager(a, data);
  if (!state.hamCup || state.hamCup.status === 'off' || !state.hamCup.gw) throw new HttpsError('failed-precondition', 'no cup drawn');
  const xi = intArray(data.xi, 'xi');
  if (!eng.xiValid(xi)) throw new HttpsError('invalid-argument', 'XI shape is illegal');
  const owned = eng.ownedIdsAt(state, eng.currentGwIndex());
  if (xi.some(id => owned.has(id))) throw new HttpsError('invalid-argument', 'Ham Cup XIs come from the Trough only');
  if (xi.some(id => !ctx.PLAYER_BY_ID[id] || eng.arrivalLocked(state, ctx.PLAYER_BY_ID[id]))) throw new HttpsError('invalid-argument', 'locked or unknown player');
  await db().ref(`${leagueBase(league)}/public/hamCup/entries/${mid}`).set(xi);
  return { ok: true };
};

ACTIONS.hamAdmin = async ({ league, a, data, state }) => {
  if (!isCommish(a)) throw new HttpsError('permission-denied', 'Chairman only');
  if (data.op === 'cancel') { await db().ref(`${leagueBase(league)}/public/hamCup`).set({ status: 'off' }); return { ok: true }; }
  if (data.op === 'draw') {
    const gw = Number(data.gw);
    if (!Number.isInteger(gw) || gw < CUP_START || gw >= Engine.REGULAR_GWS) throw new HttpsError('invalid-argument', 'draw a gameweek between the cup start and the end of the regular season');
    await db().ref(`${leagueBase(league)}/public/hamCup`).set({ gw, drawnAt: Date.now(), entries: {} });
    return { ok: true };
  }
  throw new HttpsError('invalid-argument', 'unknown op');
};

/* ----- commissioner desk ----- */
ACTIONS.settingsSet = async ({ league, a, data, state }) => {
  if (!isCommish(a)) throw new HttpsError('permission-denied', 'Chairman only');
  const base = leagueBase(league);
  if (data.scoringKey) {
    if (!(data.scoringKey in Engine.DEFAULT_SCORING)) throw new HttpsError('invalid-argument', 'unknown scoring key');
    const v = Number(data.value);
    if (!Number.isFinite(v)) throw new HttpsError('invalid-argument', 'scoring values are numbers');
    await db().ref(`${base}/public/settings/scoring/${data.scoringKey}`).set(v);
    return { ok: true };
  }
  if (data.key === 'lobusBonus') { await db().ref(`${base}/public/settings/lobusBonus`).set(Number(data.value) || 0); return { ok: true }; }
  if (data.key === 'pickTimer') { await db().ref(`${base}/public/settings/pickTimer`).set(Math.max(0, Number(data.value) || 0)); return { ok: true }; }
  if (['squadSize', 'posMin', 'posMax'].includes(data.key)) {
    if (state.phase !== 'setup') throw new HttpsError('failed-precondition', 'squad rules are fixed once the draft starts');
    await db().ref(`${base}/public/settings/${data.key}`).set(data.value);
    return { ok: true };
  }
  throw new HttpsError('invalid-argument', 'unknown setting');
};

ACTIONS.adjustmentSet = async ({ league, a, data }) => {
  if (!isCommish(a)) throw new HttpsError('permission-denied', 'Chairman only');
  const pid = Number(data.pid), v = Number(data.value);
  if (!Number.isInteger(pid) || !Number.isFinite(v)) throw new HttpsError('invalid-argument', 'bad adjustment');
  await db().ref(`${leagueBase(league)}/public/adjustments/${pid}`).set(v || null);
  return { ok: true };
};

ACTIONS.waiverControl = async ({ league, a, data, state }) => {
  if (!isCommish(a)) throw new HttpsError('permission-denied', 'Chairman only');
  if (!['auto', 'open', 'closed'].includes(data.mode)) throw new HttpsError('invalid-argument', 'auto, open or closed');
  await db().ref(`${leagueBase(league)}/public/waiverMeta`).set({ ...state.waiverMeta, control: data.mode });
  return { ok: true };
};

ACTIONS.waiverRunNow = async ({ league, a }) => {
  if (!isCommish(a)) throw new HttpsError('permission-denied', 'Chairman only');
  return runWaivers(league, `manual-${Date.now()}`, `manual:${a.uid}`);
};

/* ----- window draft ----- */
ACTIONS.windowDraft = async ({ league, a, data, ctx, state, eng }) => {
  const base = leagueBase(league);
  const op = data.op;
  if (op === 'start') {
    if (!isCommish(a)) throw new HttpsError('permission-denied', 'Chairman only');
    if (state.windowDraft?.status === 'live') throw new HttpsError('failed-precondition', 'already live');
    const order = [...state.draft.order].reverse();
    await db().ref(`${base}/public/windowDraft`).set({ status: 'live', order, turn: 0, passes: 0, picks: [] });
    return { ok: true };
  }
  if (!state.windowDraft || state.windowDraft.status !== 'live') throw new HttpsError('failed-precondition', 'no window draft running');
  const onClock = eng.wdActor(state);
  if (op === 'pick' || op === 'pass') {
    if (a.managerId !== onClock && !isCommish(a)) throw new HttpsError('permission-denied', 'not your turn');
  } else if (op === 'end') {
    if (!isCommish(a)) throw new HttpsError('permission-denied', 'Chairman only');
  } else throw new HttpsError('invalid-argument', 'unknown op');

  const finish = async () => {
    const ctx2 = await loadCtx();
    await db().ref().update({
      [`${base}/public/windowDraft/status`]: 'done',
      [`${base}/public/draftPool`]: { at: Date.now(), ids: Object.fromEntries(ctx2.PLAYERS.map(p => [p.id, p.club])) },
    });
  };
  if (op === 'end') { await finish(); return { ok: true }; }

  if (op === 'pick') {
    const inP = ctx.PLAYER_BY_ID[data.inId], outP = ctx.PLAYER_BY_ID[data.outId];
    if (!inP || !outP) throw new HttpsError('invalid-argument', 'unknown player');
    if (!eng.isArrival(state, inP)) throw new HttpsError('failed-precondition', 'the Window Draft is for new arrivals only');
    const tgw = eng.transferGw();
    if (eng.ownedIdsAt(state, tgw).has(inP.id)) throw new HttpsError('failed-precondition', 'already owned');
    const squad = eng.squadAt(state, onClock, tgw);
    if (!squad.some(p => p.id === outP.id)) throw new HttpsError('failed-precondition', 'not yours to drop');
    if (!eng.squadShapeOk(state, [...squad.filter(p => p.id !== outP.id), inP])) throw new HttpsError('failed-precondition', 'squad shape would be illegal');
    await appendTransfers(league, state, eng, [{ managerId: onClock, outId: outP.id, inId: inP.id, gw: tgw, t: Date.now(), windowDraft: true }], tgw);
    await stripLineup(league, state, onClock, tgw, outP.id);
  }
  const res = await db().ref(`${base}/public/windowDraft`).transaction(wd => {
    if (wd === null) wd = JSON.parse(JSON.stringify(state.windowDraft)); // empty-cache first pass
    if (!wd) return;
    wd.order = toArr(wd.order); wd.picks = toArr(wd.picks);
    if (op === 'pick') wd.picks.push({ mid: onClock, in: Number(data.inId), out: Number(data.outId) });
    wd.passes = op === 'pass' ? (wd.passes || 0) + 1 : 0;
    wd.turn = (wd.turn || 0) + 1;
    return wd;
  });
  const wd = res.snapshot.val();
  if (wd && (wd.passes >= toArr(wd.order).length)) await finish();
  return { ok: true };
};

/* ----- reset / import (the nuclear desk) ----- */
ACTIONS.resetLeague = async ({ league, a, data }) => {
  if (!isCommish(a)) throw new HttpsError('permission-denied', 'Chairman only');
  if (data.confirm !== 'RESET') throw new HttpsError('failed-precondition', 'type RESET to confirm');
  const base = leagueBase(league);
  // membership survives a reset — identities are not game state
  await db().ref(`${base}/public/phase`).set('setup');
  await db().ref().update({ [`${base}/public`]: null, [`${base}/private`]: null, [`${base}/server/waiverRuns`]: null });
  return { ok: true };
};

ACTIONS.importState = async ({ league, a, data }) => {
  if (!isCommish(a)) throw new HttpsError('permission-denied', 'Chairman only');
  const s = data.state;
  if (!s || !toArr(s.managers).length || !s.phase) throw new HttpsError('invalid-argument', 'not a league export');
  const base = leagueBase(league);
  const pub = { ...s };
  delete pub.pins; delete pub.claims; delete pub.autolists; delete pub.matchStats; delete pub.fixtures; delete pub.lastSync; delete pub.view; delete pub.feedGenerated;
  const upd = { [`${base}/public`]: pub };
  const mem = (await db().ref(`${base}/server/managerUid`).get()).val() || {};
  for (const [g, byMid] of Object.entries(s.claims || {})) {
    for (const [mid, arr] of Object.entries(byMid || {})) {
      const uid = mem[mid];
      if (uid) upd[`${base}/private/${uid}/claims/${g}`] = toArr(arr);
    }
  }
  for (const [mid, arr] of Object.entries(s.autolists || {})) {
    const uid = mem[mid];
    if (uid) upd[`${base}/private/${uid}/autolist`] = toArr(arr);
  }
  await db().ref().update(upd);
  return { ok: true };
};

/* ---------------- entry points ---------------- */
exports.ping = onCall(req => ({ ok: true, uid: req.auth?.uid || null }));

exports.mutate = onCall(async req => {
  const { league, action, data = {} } = req.data || {};
  const fn = ACTIONS[action];
  if (!fn) throw new HttpsError('invalid-argument', `unknown action ${action}`);
  const a = await actor(req, league);
  const ctx = await loadCtx();
  const needsState = !['autolistSet', 'claimSet', 'adjustmentSet', 'waiverRunNow', 'resetLeague', 'importState'].includes(action);
  const state = needsState ? await loadState(league, ctx) : null;
  return fn({ league, a, data, ctx, state, eng: ctx.eng });
});

// Tue & Fri 10:02 UTC, mirroring the old Action. Run id is derived from the
// schedule slot so retries of the same slot can never double-process.
exports.waiverTick = onSchedule({ schedule: '2 10 * * 2,5', timeZone: 'Etc/UTC', retryCount: 3 }, async () => {
  const slot = new Date().toISOString().slice(0, 10);
  await runWaivers('the-league-2627', `sched-${slot}`, 'schedule');
});

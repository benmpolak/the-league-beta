/* The League — server-authoritative mutation layer (Cloud Functions v2).
 *
 * Every consequential write to the league goes through `mutate` (or the
 * scheduled waiver runner). The actor is ALWAYS derived from the verified
 * auth token — request data never names who is acting. Game legality is
 * enforced with the same engine the client renders with (js/engine.js,
 * copied here at deploy; parity guarded by test/engine.parity.test.js).
 *
 * Authority: the server-owned membership node is the ONLY source of who may
 * act. Custom claims on the token are never trusted — a revoked or
 * downgraded manager is powerless the moment membership says so.
 *
 * Reference data (players/gameweeks/stats) is fetched as PURE JSON from the
 * deployed site and strictly validated (functions/feedcheck.js). Nothing
 * fetched is ever executed.
 *
 * Data layout (see database.rules.v2.json — clients cannot write ANY of it):
 *   v2/leagues/$l/public/...            world-readable game state
 *   v2/leagues/$l/private/$uid/...      autolist + waiver claims (owner-read)
 *   v2/leagues/$l/server/membership     uid -> {managerId, role}
 *   v2/leagues/$l/server/managerUid     managerId -> uid
 *   v2/leagues/$l/server/waiverRuns     runId -> {status, plan, ...}
 */
'use strict';
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const Engine = require('./engine.js');
const Feed = require('./feedcheck.js');

setGlobalOptions({ region: 'europe-west1', maxInstances: 5 });
// explicit databaseURL: the emulator redirects the transport, but the
// NAMESPACE comes from this URL — leaving it implicit made the emulated
// functions read a different (empty) database depending on tooling version
admin.initializeApp({
  databaseURL: 'https://calciopoli-wc26-default-rtdb.europe-west1.firebasedatabase.app',
});

const LEAGUES = ['the-league-2627', 'the-league-sandbox'];
const CUP_START = 7;
// reference data comes from the deployed site (updated every 15 min by the
// FPL Action) so functions never need redeploying for data
const DATA_BASE = process.env.DATA_BASE_URL || 'https://benmpolak.github.io/the-league';

/* Failure injection for the emulator suites ONLY — proves crash recovery at
 * write boundaries. Inert in production: the env var is set by the emulator. */
const EMULATED = process.env.FUNCTIONS_EMULATOR === 'true';
function failpoint(failAt, name) {
  if (EMULATED && failAt === name) throw new Error(`failpoint:${name}`);
}

/* ---------------- reference data (players / gameweeks / stats) ---------------- */
async function fetchJson(rel, label, maxBytes, { optional = false } = {}) {
  const r = await fetch(`${DATA_BASE}/${rel}?t=${Date.now()}`);
  if (!r.ok) {
    if (optional) return null;
    throw new Error(`${label} ${r.status}`);
  }
  const text = await r.text();
  return Feed.parseJson(text, label, maxBytes); // size-capped, parsed as data only
}

let _ctxCache = null;
async function loadCtx() {
  if (_ctxCache && Date.now() - _ctxCache.at < 5 * 60 * 1000) return _ctxCache;
  const [dataRaw, histRaw, statsRaw] = await Promise.all([
    fetchJson('data/data.json', 'data.json', Feed.LIMITS.dataBytes),
    fetchJson('data/history25.json', 'history25.json', Feed.LIMITS.historyBytes, { optional: true }),
    fetchJson('data/stats.json', 'stats.json', Feed.LIMITS.statsBytes),
  ]);
  const { TEAMS, PLAYERS, GAMEWEEKS_RAW } = Feed.validateData(dataRaw);
  const LAST_SEASON = histRaw ? Feed.validateHistory(histRaw) : { byCode: {} };
  const statsRes = Feed.validateStats(statsRaw);
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
  // membership is the ONLY authority. The custom claim on the token is at
  // most a UI hint — it never grants access and never overrides a missing,
  // revoked or downgraded membership entry.
  const m = (await db().ref(`${base}/server/membership/${uid}`).get()).val();
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
// every user-supplied id list comes through here: integer ids only, hard cap
const intArray = (x, name, max = 100) => {
  const a = toArr(x).map(Number);
  if (a.length > max) throw new HttpsError('invalid-argument', `${name}: too many entries (max ${max})`);
  if (a.some(n => !Number.isInteger(n) || n < 0 || n > 99999999)) throw new HttpsError('invalid-argument', `${name} must be player ids`);
  return a;
};
const cleanText = (v, max) => String(v == null ? '' : v).slice(0, max);

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

/* ---------------- the waiver core (shared by schedule + run-now) ----------------
 * Recoverable, effectively exactly-once:
 *   1. claim the run id under a short lease (txn)
 *   2. compute the resolution and persist it as a durable PLAN on the run record
 *   3. apply the plan: transfer append is idempotent (records tagged with the
 *      run id are skipped on replay), then one atomic update clears claims,
 *      stamps meta, strips lineups and marks the run done
 * A crash at any point leaves a re-claimable record whose stored plan replays
 * without double-applying. While a fresh lease is held, callers get an ERROR
 * (never a false success), so the Scheduler's retry keeps retrying until the
 * lease expires and the work really completes. */
const WAIVER_LEASE_MS = 3 * 60 * 1000;

async function applyWaiverPlan(league, runId, plan, state, eng) {
  if (!plan.records || !plan.records.length) return { applied: 0, dropped: 0 };
  const ref = db().ref(`${leagueBase(league)}/public/transfers`);
  const seedSnap = (await ref.get()).val();
  let applied = 0, dropped = 0;
  const res = await ref.transaction(cur => {
    const out = toArr(cur === null ? seedSnap : cur).map(x => ({ ...x }));
    applied = 0; dropped = 0;
    const have = new Set(out.filter(t => t && t.waiver && t.runId === runId)
      .map(t => `${t.managerId}:${t.inId}:${t.outId}`));
    for (const r of plan.records) {
      if (have.has(`${r.managerId}:${r.inId}:${r.outId}`)) { applied++; continue; } // replay — already landed
      const owned = eng.ownedIdsGiven(state, out, plan.tgw);
      if (owned.has(r.inId) || !owned.has(r.outId)) { dropped++; continue; } // sniped since planning — claim lapses
      out.push({ ...r, n: out.length + 1 });
      applied++;
    }
    return out;
  });
  if (!res.committed) throw new HttpsError('aborted', 'transfer ledger contended — run again');
  return { applied, dropped };
}

async function runWaivers(league, runId, trigger, failAt) {
  const base = leagueBase(league);
  const runRef = db().ref(`${base}/server/waiverRuns/${runId}`);
  const now0 = Date.now();
  const claim = await runRef.transaction(cur => {
    if (cur && cur.status === 'done') return; // abort: nothing to do
    if (cur && (cur.status === 'running' || cur.status === 'applying')
      && now0 - (cur.startedAt || 0) < WAIVER_LEASE_MS) return; // abort: live lease
    // (re)claim — keep any stored plan so a crashed run replays, not recomputes
    return { ...(cur || {}), status: cur?.plan ? 'applying' : 'running', trigger, startedAt: now0, attempt: ((cur && cur.attempt) || 0) + 1 };
  });
  if (!claim.committed) {
    if (claim.snapshot.val()?.status === 'done') return { skipped: 'already processed' };
    // a live lease means the work is (or may still be) happening — an error,
    // never a success, so schedulers retry instead of assuming completion
    throw new HttpsError('aborted', 'waiver run already in progress — retry shortly');
  }
  try {
    const ctx = await loadCtx();
    if (ctx.feedGenerated && Date.now() - new Date(ctx.feedGenerated).getTime() > 90 * 60 * 1000) {
      throw new Error('stats feed is stale (>90 min) — refusing to run waivers on old scores');
    }
    const eng = ctx.eng;
    const state = await loadState(league, ctx, { withPrivate: true });
    let plan = claim.snapshot.val()?.plan || null;
    if (!plan) {
      if (state.phase !== 'season') { await runRef.update({ status: 'done', result: 'skipped: not in season', finishedAt: Date.now() }); return { skipped: 'not in season' }; }
      if (trigger === 'schedule' && eng.waiverControl(state) !== 'auto') { await runRef.update({ status: 'done', result: 'skipped: control!=auto', finishedAt: Date.now() }); return { skipped: 'control' }; }
      if (trigger === 'schedule' && !eng.waiverRunDue(state)) { await runRef.update({ status: 'done', result: 'skipped: not due', finishedAt: Date.now() }); return { skipped: 'not due' }; }
      const runStart = Date.now() - 1;
      const res = eng.resolveWaivers(state, runStart);
      plan = {
        records: res.records.map(r => ({ ...r, runId })), executed: res.executed,
        buckets: res.buckets, stampedMeta: res.stampedMeta,
        strippedLineups: res.strippedLineups, tgw: res.tgw,
      };
      await runRef.update({ status: 'applying', plan });
    }
    failpoint(failAt, 'waivers:afterPlan');
    const { applied, dropped } = await applyWaiverPlan(league, runId, plan, state, eng);
    failpoint(failAt, 'waivers:afterTransfers');
    const mem = (await db().ref(`${base}/server/membership`).get()).val() || {};
    const upd = {};
    upd[`${base}/public/waiverMeta`] = plan.stampedMeta;
    for (const uid of Object.keys(mem)) for (const g of (plan.buckets || [])) upd[`${base}/private/${uid}/claims/${g}`] = null;
    for (const [mid, xi] of Object.entries(plan.strippedLineups || {})) upd[`${base}/public/lineups/${mid}/${plan.tgw}`] = xi;
    upd[`${base}/server/waiverRuns/${runId}/status`] = 'done';
    upd[`${base}/server/waiverRuns/${runId}/finishedAt`] = Date.now();
    upd[`${base}/server/waiverRuns/${runId}/executed`] = plan.executed || [];
    upd[`${base}/server/waiverRuns/${runId}/applied`] = applied;
    upd[`${base}/server/waiverRuns/${runId}/dropped`] = dropped;
    await db().ref().update(upd);
    return { executed: plan.executed || [] };
  } catch (e) {
    // release the lease; the plan (if written) survives for an exact replay
    await runRef.update({ status: 'failed', error: String(e.message || e), finishedAt: Date.now() }).catch(() => {});
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
    const order = intArray(data.order, 'order', 20);
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
  const xi = intArray(data.xi, 'xi', 11);
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
  // bench order shapes auto-subs, so it locks with the lineup — exactly like lineupSave
  if (eng.gwHasStarted(gw)) throw new HttpsError('failed-precondition', 'that gameweek has kicked off');
  const pids = intArray(data.pids, 'pids', 30);
  if (new Set(pids).size !== pids.length) throw new HttpsError('invalid-argument', 'bench order repeats a player');
  const squadIds = new Set(eng.squadAt(state, mid, gw).map(p => p.id));
  if (!pids.every(id => squadIds.has(id))) throw new HttpsError('invalid-argument', 'bench order names players not in the squad');
  await db().ref(`${leagueBase(league)}/public/benchOrders/${mid}/${gw}`).set(pids);
  return { ok: true };
};

ACTIONS.autolistSet = async ({ league, a, data, ctx }) => {
  const pids = intArray(data.pids, 'pids', 300);
  if (new Set(pids).size !== pids.length) throw new HttpsError('invalid-argument', 'autolist repeats a player');
  if (pids.some(id => !ctx.PLAYER_BY_ID[id])) throw new HttpsError('invalid-argument', 'autolist names an unknown player');
  await db().ref(`${leagueBase(league)}/private/${a.uid}/autolist`).set(pids);
  return { ok: true };
};

ACTIONS.claimSet = async ({ league, a, data, eng, ctx, state }) => {
  const g = Number(data.gwIndex);
  const cur = eng.currentGwIndex();
  if (!Number.isInteger(g) || Math.abs(g - cur) > 1) throw new HttpsError('invalid-argument', 'claims go in the current gameweek bucket');
  const raw = toArr(data.claims);
  if (raw.length > 30) throw new HttpsError('invalid-argument', 'too many claims (max 30)');
  const claims = raw.map(c => ({ in: Number(c && c.in), out: Number(c && c.out) }));
  if (claims.some(c => !Number.isInteger(c.in) || !Number.isInteger(c.out))) throw new HttpsError('invalid-argument', 'bad claim');
  const tgw = eng.transferGw();
  const squad = eng.squadAt(state, a.managerId, tgw);
  const squadIds = new Set(squad.map(p => p.id));
  for (const c of claims) {
    const inP = ctx.PLAYER_BY_ID[c.in];
    if (!inP) throw new HttpsError('invalid-argument', 'claim names an unknown player');
    if (squadIds.has(c.in)) throw new HttpsError('failed-precondition', 'you already own that player');
    if (!squadIds.has(c.out)) throw new HttpsError('failed-precondition', 'the drop player is not in your squad');
    if (!eng.squadShapeOk(state, [...squad.filter(p => p.id !== c.out), inP])) throw new HttpsError('failed-precondition', 'claim would leave an illegal squad shape');
  }
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
  const cap = state.settings.squadSize || 14;
  const give = intArray(data.give, 'give', cap), get = intArray(data.get, 'get', cap);
  if (!give.length || give.length !== get.length) throw new HttpsError('invalid-argument', 'trades swap the same number each way');
  const tgw = eng.transferGw();
  const mine = eng.squadIdsGiven(state, from, state.transfers, tgw);
  const theirs = eng.squadIdsGiven(state, to, state.transfers, tgw);
  if (!give.every(id => mine.has(id)) || !get.every(id => theirs.has(id))) throw new HttpsError('failed-precondition', 'players not owned by the right sides');
  const offer = {
    id: `t${Date.now()}-${from}`, from, to, give, get,
    terms: cleanText(data.terms, 400), status: 'pending', t: Date.now(),
  };
  const res = await db().ref(`${leagueBase(league)}/public/trades`).transaction(seeded(state.trades, arr => {
    if (arr.length >= 1000) return; // ledger cap — a real league never gets near this
    return [...arr, offer];
  }));
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
  const cov = { id: `c${Date.now()}-${from}`, from, to, text: cleanText(data.text, 400), t: Date.now(), gw: data.gw ?? null };
  const res = await db().ref(`${leagueBase(league)}/public/covenants`).transaction(seeded(state.covenants, arr => {
    if (arr.length >= 500) return; // register cap
    return [...arr, cov];
  }));
  if (!res.committed) throw new HttpsError('aborted', 'the register is full or contended');
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
  await db().ref(`${leagueBase(league)}/public/managers/${idx}/stadium`).set(cleanText(data.name, 60));
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
  const xi = intArray(data.xi, 'xi', 11);
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
const POS_KEYS = ['GK', 'DF', 'MF', 'FW'];
// squadSize + posMin + posMax must describe a squad that can actually exist
function validateSquadRules({ squadSize, posMin, posMax }) {
  if (!Number.isInteger(squadSize) || squadSize < 11 || squadSize > 25) throw new HttpsError('invalid-argument', 'squad size runs 11-25');
  let smin = 0, smax = 0;
  for (const k of POS_KEYS) {
    const lo = posMin?.[k], hi = posMax?.[k];
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo || hi > squadSize) throw new HttpsError('invalid-argument', `position bounds for ${k} are inconsistent`);
    smin += lo; smax += hi;
  }
  if (posMin.GK < 1) throw new HttpsError('invalid-argument', 'at least one keeper');
  if (smin > squadSize || smax < squadSize) throw new HttpsError('invalid-argument', 'position bounds cannot produce a legal squad');
}
function checkPosObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpsError('invalid-argument', 'position rules are an object');
  const keys = Object.keys(v);
  if (keys.length !== 4 || POS_KEYS.some(k => !keys.includes(k))) throw new HttpsError('invalid-argument', 'position rules need exactly GK/DF/MF/FW');
  for (const k of keys) if (!Number.isInteger(v[k]) || v[k] < 0 || v[k] > 25) throw new HttpsError('invalid-argument', `bad bound for ${k}`);
  return v;
}

ACTIONS.settingsSet = async ({ league, a, data, state }) => {
  if (!isCommish(a)) throw new HttpsError('permission-denied', 'Chairman only');
  const base = leagueBase(league);
  if (data.scoringKey) {
    if (!(data.scoringKey in Engine.DEFAULT_SCORING)) throw new HttpsError('invalid-argument', 'unknown scoring key');
    const v = Number(data.value);
    if (!Number.isFinite(v) || Math.abs(v) > 100) throw new HttpsError('invalid-argument', 'scoring values are numbers (|v| <= 100)');
    await db().ref(`${base}/public/settings/scoring/${data.scoringKey}`).set(v);
    return { ok: true };
  }
  if (data.key === 'lobusBonus') {
    const v = Number(data.value) || 0;
    if (Math.abs(v) > 100) throw new HttpsError('invalid-argument', 'be serious');
    await db().ref(`${base}/public/settings/lobusBonus`).set(v);
    return { ok: true };
  }
  if (data.key === 'pickTimer') {
    const v = Math.max(0, Number(data.value) || 0);
    if (v > 3600) throw new HttpsError('invalid-argument', 'pick timer runs 0-3600 seconds');
    await db().ref(`${base}/public/settings/pickTimer`).set(v);
    return { ok: true };
  }
  if (['squadSize', 'posMin', 'posMax'].includes(data.key)) {
    if (state.phase !== 'setup') throw new HttpsError('failed-precondition', 'squad rules are fixed once the draft starts');
    const next = { squadSize: state.settings.squadSize, posMin: state.settings.posMin, posMax: state.settings.posMax };
    if (data.key === 'squadSize') next.squadSize = Number(data.value);
    else next[data.key] = checkPosObject(data.value);
    validateSquadRules(next);
    await db().ref(`${base}/public/settings/${data.key}`).set(data.key === 'squadSize' ? next.squadSize : next[data.key]);
    return { ok: true };
  }
  throw new HttpsError('invalid-argument', 'unknown setting');
};

ACTIONS.adjustmentSet = async ({ league, a, data }) => {
  if (!isCommish(a)) throw new HttpsError('permission-denied', 'Chairman only');
  const pid = Number(data.pid), v = Number(data.value);
  if (!Number.isInteger(pid) || !Number.isFinite(v) || Math.abs(v) > 1000) throw new HttpsError('invalid-argument', 'bad adjustment');
  await db().ref(`${leagueBase(league)}/public/adjustments/${pid}`).set(v || null);
  return { ok: true };
};

ACTIONS.waiverControl = async ({ league, a, data, state }) => {
  if (!isCommish(a)) throw new HttpsError('permission-denied', 'Chairman only');
  if (!['auto', 'open', 'closed'].includes(data.mode)) throw new HttpsError('invalid-argument', 'auto, open or closed');
  await db().ref(`${leagueBase(league)}/public/waiverMeta`).set({ ...state.waiverMeta, control: data.mode });
  return { ok: true };
};

ACTIONS.waiverRunNow = async ({ league, a, data }) => {
  if (!isCommish(a)) throw new HttpsError('permission-denied', 'Chairman only');
  return runWaivers(league, data.runId ? `manual-${cleanText(data.runId, 40)}` : `manual-${Date.now()}`, `manual:${a.uid}`, EMULATED ? data.__failpoint : undefined);
};

/* ----- window draft ----- */
/* pick/pass/end run as ONE transaction on the whole public node: turn check,
 * transfer append, lineup strip, pick record, pass counter and completion all
 * commit together or not at all — no partial state to recover from. */
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
  if (!['pick', 'pass', 'end'].includes(op)) throw new HttpsError('invalid-argument', 'unknown op');
  if (op === 'end' && !isCommish(a)) throw new HttpsError('permission-denied', 'Chairman only');
  if (!state.windowDraft || state.windowDraft.status !== 'live') throw new HttpsError('failed-precondition', 'no window draft running');
  failpoint(EMULATED ? data.__failpoint : undefined, 'wd:beforeTxn');

  const poolIds = Object.fromEntries(ctx.PLAYERS.map(p => [p.id, p.club]));
  const pubRef = db().ref(`${base}/public`);
  const rawSeed = (await pubRef.get()).val(); // fresh raw value for the null first pass
  let deny = null; // {code, msg} decided inside the txn on its final attempt
  const res = await pubRef.transaction(cur => {
    const pub = structuredClone(cur === null ? rawSeed : cur);
    deny = null;
    if (!pub) { deny = { code: 'failed-precondition', msg: 'league not initialised' }; return; }
    const s = normalizeState(structuredClone(pub), ctx); // read-only view for the engine
    const wd = s.windowDraft;
    if (!wd || wd.status !== 'live') { deny = { code: 'failed-precondition', msg: 'no window draft running' }; return; }
    if (Number.isInteger(data.expectedTurn) && data.expectedTurn !== (wd.turn || 0)) { deny = { code: 'aborted', msg: 'the window moved on' }; return; }
    if (op === 'end') {
      pub.windowDraft = { ...pub.windowDraft, status: 'done' };
      pub.draftPool = { at: Date.now(), ids: poolIds };
      return pub;
    }
    const onClock = eng.wdActor(s);
    if (a.managerId !== onClock && !isCommish(a)) { deny = { code: 'permission-denied', msg: 'not your turn' }; return; }
    const wdRaw = pub.windowDraft;
    wdRaw.order = toArr(wdRaw.order);
    wdRaw.picks = toArr(wdRaw.picks);
    if (op === 'pick') {
      const inP = ctx.PLAYER_BY_ID[Number(data.inId)], outP = ctx.PLAYER_BY_ID[Number(data.outId)];
      if (!inP || !outP) { deny = { code: 'invalid-argument', msg: 'unknown player' }; return; }
      if (!eng.isArrival(s, inP)) { deny = { code: 'failed-precondition', msg: 'the Window Draft is for new arrivals only' }; return; }
      const tgw = eng.transferGw();
      if (eng.ownedIdsAt(s, tgw).has(inP.id)) { deny = { code: 'failed-precondition', msg: 'already owned' }; return; }
      const squad = eng.squadAt(s, onClock, tgw);
      if (!squad.some(p => p.id === outP.id)) { deny = { code: 'failed-precondition', msg: 'not yours to drop' }; return; }
      if (!eng.squadShapeOk(s, [...squad.filter(p => p.id !== outP.id), inP])) { deny = { code: 'failed-precondition', msg: 'squad shape would be illegal' }; return; }
      const transfers = toArr(pub.transfers);
      transfers.push({ managerId: onClock, outId: outP.id, inId: inP.id, gw: tgw, t: Date.now(), windowDraft: true, n: transfers.length + 1 });
      pub.transfers = transfers;
      const lu = pub.lineups?.[onClock]?.[tgw];
      if (lu) pub.lineups[onClock][tgw] = toArr(lu).filter(id => id !== outP.id);
      wdRaw.picks.push({ mid: onClock, in: inP.id, out: outP.id });
      wdRaw.passes = 0;
    } else {
      wdRaw.passes = (wdRaw.passes || 0) + 1;
    }
    wdRaw.turn = (wdRaw.turn || 0) + 1;
    if (wdRaw.passes >= wdRaw.order.length) {
      wdRaw.status = 'done'; // a full lap of passes ends the window in the same commit
      pub.draftPool = { at: Date.now(), ids: poolIds };
    }
    return pub;
  });
  if (!res.committed) {
    const d = deny || { code: 'aborted', msg: 'try again' };
    throw new HttpsError(d.code, d.msg);
  }
  const wdAfter = res.snapshot.val()?.windowDraft || null;
  return { ok: true, turn: wdAfter?.turn ?? null, status: wdAfter?.status ?? null };
};

/* ----- reset / import (the nuclear desk) ----- */
// the 12, as they appear in the client's freshState — the fallback roster when
// a reset finds no managers to carry over
const DEFAULT_ROSTER = [
  { id: 1, name: 'Ben Polak', team: 'The Dog’s Polaks' },
  { id: 2, name: 'Toby Levy', team: 'Chairman Mao *°' },
  { id: 3, name: 'Ben Levy', team: 'Atlético Benfield' },
  { id: 4, name: 'Adam Jackson', team: 'Interjacksonale*' },
  { id: 5, name: 'Ian Tussie', team: 'Champagne Khusanova FC' },
  { id: 6, name: 'Alex Singer', team: 'Singer’s Spartans' },
  { id: 7, name: 'Ric Blank', team: 'Asterick' },
  { id: 8, name: 'Marc Conway', team: '101011101' },
  { id: 9, name: 'Alex Duckett', team: 'Mighty 🦆 *' },
  { id: 10, name: 'Lee Warner', team: 'Celta Leigh-Go' },
  { id: 11, name: 'Daniel Geller', team: 'Geldog FC' },
  { id: 12, name: 'Wilko Wilkowski', team: 'WA Wanderers' },
];
const DEFAULT_SETTINGS = () => ({
  squadSize: 14,
  posMin: { GK: 1, DF: 3, MF: 3, FW: 1 },
  posMax: { GK: 2, DF: 6, MF: 6, FW: 4 },
  pickTimer: 30,
  scoring: { ...Engine.DEFAULT_SCORING },
});
function canonicalSetupState(prevPub) {
  const prev = prevPub || {};
  const managers = toArr(prev.managers).length ? toArr(prev.managers) : DEFAULT_ROSTER;
  // carry the Committee's settings through a reset when they are still sane
  let settings = DEFAULT_SETTINGS();
  if (prev.settings) {
    const cand = {
      ...DEFAULT_SETTINGS(),
      ...prev.settings,
      scoring: { ...Engine.DEFAULT_SCORING, ...(prev.settings.scoring || {}) },
    };
    try { validateSquadRules(cand); settings = cand; } catch { /* keep defaults */ }
  }
  return {
    phase: 'setup',
    managers,
    settings,
    waiverMeta: { lastRun: null, control: 'auto' },
  };
}

/* A confirmed reset atomically installs a valid setup-state, clears private
 * game data (claims/autolists) and the waiver run log, preserves membership,
 * and leaves the commissioner able to start a new draft immediately. */
ACTIONS.resetLeague = async ({ league, a, data }) => {
  if (!isCommish(a)) throw new HttpsError('permission-denied', 'Chairman only');
  if (data.confirm !== 'RESET') throw new HttpsError('failed-precondition', 'type RESET to confirm');
  const base = leagueBase(league);
  const prevPub = (await db().ref(`${base}/public`).get()).val();
  await db().ref().update({
    [`${base}/public`]: canonicalSetupState(prevPub),
    [`${base}/private`]: null,
    [`${base}/server/waiverRuns`]: null,
  });
  return { ok: true };
};

/* importState is the commissioner's restore path (empty-cloud seed / file
 * import) — strict allowed-key schema, typed sections, hard size cap. */
const IMPORT_ALLOWED = new Set([
  'phase', 'managers', 'settings', 'draft', 'lineups', 'transfers', 'trades',
  'covenants', 'waiverMeta', 'adjustments', 'shirtNums', 'draftPool',
  'windowDraft', 'tradeBlock', 'benchOrders', 'lobus', 'hamCup',
  'claims', 'autolists',
]);
// legacy-export debris: silently dropped, never imported
const IMPORT_DROPPED = new Set(['pins', 'matchStats', 'fixtures', 'lastSync', 'view', 'feedGenerated']);
const isPlainObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
function importError(msg) { throw new HttpsError('invalid-argument', `not a valid league export: ${msg}`); }

ACTIONS.importState = async ({ league, a, data }) => {
  if (!isCommish(a)) throw new HttpsError('permission-denied', 'Chairman only');
  const s = data.state;
  if (!isPlainObj(s)) importError('not an object');
  const bytes = Buffer.byteLength(JSON.stringify(s), 'utf8');
  if (bytes > 4 * 1024 * 1024) importError(`too large (${bytes} bytes)`);
  for (const k of Object.keys(s)) {
    if (!IMPORT_ALLOWED.has(k) && !IMPORT_DROPPED.has(k)) importError(`unknown key "${k}"`);
  }
  if (!['setup', 'draft', 'season'].includes(s.phase)) importError('bad phase');
  const managers = toArr(s.managers);
  if (managers.length < 2 || managers.length > 20) importError('managers');
  const midSeen = new Set();
  for (const m of managers) {
    if (!isPlainObj(m) || !Number.isInteger(m.id) || m.id < 1 || m.id > 99 || midSeen.has(m.id)) importError('manager entry');
    midSeen.add(m.id);
    for (const k of Object.keys(m)) if (!['id', 'name', 'team', 'stadium'].includes(k)) importError(`manager key "${k}"`);
    if (typeof m.name !== 'string' || m.name.length > 60) importError('manager name');
    if (typeof m.team !== 'string' || m.team.length > 80) importError('manager team');
    if (m.stadium != null && (typeof m.stadium !== 'string' || m.stadium.length > 80)) importError('manager stadium');
  }
  if (s.settings != null) {
    if (!isPlainObj(s.settings)) importError('settings');
    for (const k of Object.keys(s.settings)) {
      if (!['squadSize', 'posMin', 'posMax', 'pickTimer', 'scoring', 'lobusBonus'].includes(k)) importError(`settings key "${k}"`);
    }
    const cand = { ...DEFAULT_SETTINGS(), ...s.settings };
    validateSquadRules(cand); // throws its own HttpsError on nonsense
    if (s.settings.scoring != null) {
      if (!isPlainObj(s.settings.scoring)) importError('scoring');
      for (const [k, v] of Object.entries(s.settings.scoring)) {
        if (!(k in Engine.DEFAULT_SCORING) || typeof v !== 'number' || !Number.isFinite(v)) importError(`scoring "${k}"`);
      }
    }
  }
  const arrayCaps = { transfers: 5000, trades: 1000, covenants: 500 };
  for (const [k, cap] of Object.entries(arrayCaps)) {
    if (s[k] != null && toArr(s[k]).length > cap) importError(`${k} too long`);
    if (s[k] != null && toArr(s[k]).some(x => x != null && !isPlainObj(x))) importError(`${k} entries`);
  }
  for (const k of ['lineups', 'benchOrders', 'shirtNums', 'tradeBlock', 'lobus', 'adjustments', 'claims', 'autolists']) {
    if (s[k] != null && !isPlainObj(s[k])) importError(k);
    if (s[k] != null && Object.keys(s[k]).length > 200) importError(`${k} too large`);
  }
  if (s.draft != null && !isPlainObj(s.draft)) importError('draft');
  if (s.draft?.picks != null && toArr(s.draft.picks).length > 500) importError('draft picks');

  const base = leagueBase(league);
  const pub = {};
  for (const k of Object.keys(s)) {
    if (IMPORT_ALLOWED.has(k) && k !== 'claims' && k !== 'autolists') pub[k] = s[k];
  }
  const upd = { [`${base}/public`]: pub };
  const mem = (await db().ref(`${base}/server/managerUid`).get()).val() || {};
  for (const [g, byMid] of Object.entries(s.claims || {})) {
    if (!/^\d{1,2}$/.test(g)) importError(`claims bucket "${g}"`);
    for (const [mid, arr] of Object.entries(byMid || {})) {
      const list = toArr(arr);
      if (list.length > 30) importError('claims bucket too long');
      const uid = mem[mid];
      if (uid) upd[`${base}/private/${uid}/claims/${g}`] = list;
    }
  }
  for (const [mid, arr] of Object.entries(s.autolists || {})) {
    const list = toArr(arr);
    if (list.length > 300) importError('autolist too long');
    const uid = mem[mid];
    if (uid) upd[`${base}/private/${uid}/autolist`] = list;
  }
  await db().ref().update(upd);
  return { ok: true };
};

/* ---------------- entry points ---------------- */
exports.ping = onCall(req => ({ ok: true, uid: req.auth?.uid || null }));

exports.mutate = onCall(async req => {
  const { league, action, data = {} } = req.data || {};
  if (!isPlainObj(data)) throw new HttpsError('invalid-argument', 'bad data');
  const fn = ACTIONS[action];
  if (!fn) throw new HttpsError('invalid-argument', `unknown action ${action}`);
  const a = await actor(req, league);
  const ctx = await loadCtx();
  const needsState = !['autolistSet', 'adjustmentSet', 'waiverRunNow', 'resetLeague', 'importState'].includes(action);
  const state = needsState ? await loadState(league, ctx) : null;
  return fn({ league, a, data, ctx, state, eng: ctx.eng });
});

// Tue & Fri 10:02 UTC, mirroring the old Action. Run id is derived from the
// schedule slot so retries of the same slot can never double-process — and a
// retry hitting a live lease gets an error, not a hollow success.
exports.waiverTick = onSchedule({ schedule: '2 10 * * 2,5', timeZone: 'Etc/UTC', retryCount: 3 }, async () => {
  const slot = new Date().toISOString().slice(0, 10);
  await runWaivers('the-league-2627', `sched-${slot}`, 'schedule');
});

/* ================= The League — 2026/27 ================= */
'use strict';

const LS_KEY = 'tl2627-league';

const TEAM_BY_NAME = Object.fromEntries(TEAMS.map(t => [t.name, t]));
const PLAYER_BY_ID = Object.fromEntries(PLAYERS.map(p => [p.id, p]));

/* ---- last season's archive (js/history25.js) ----
   The FPL API zeroes every aggregate when it flips to 26/27 in July. The
   archive was taken first, keyed by the immutable player code — so the
   draft pool still sorts on real numbers on draft night. */
const LS_BY_CODE = (typeof LAST_SEASON !== 'undefined' && LAST_SEASON.byCode) || {};
const LS_SEASON = (typeof LAST_SEASON !== 'undefined' && LAST_SEASON.season) || 'last season';
const lastSeasonOf = p => LS_BY_CODE[p.code];
// has the API flipped and wiped? (a full season's totals sum to ~50k)
const FPL_WIPED = PLAYERS.reduce((t, p) => t + (p.pts || 0), 0) < 2000;
const POS_ORDER = { GK: 0, DF: 1, MF: 2, FW: 3 };
const POS_LABEL = { GK: 'Goalkeepers', DF: 'Defenders', MF: 'Midfielders', FW: 'Forwards' };
// how many players outrank you on last season's points — used for pundit judgement
const ratingRank = r => PLAYERS.filter(x => (x.rating ?? 0) > r).length;

// Draft Fantasy's default table (docs.draftfantasy.com), minus bonus points.
// Yes, a goalkeeper goal really is 10.
const DEFAULT_SCORING = {
  appearance: 1,
  appearance60: 2,
  goalGK: 10, goalDF: 6, goalMF: 5, goalFW: 4,
  assist: 3,
  cleanSheet: 4,
  cleanSheetMF: 1,
  per3Saves: 1,
  penSave: 5,
  penMiss: -2,
  yellow: -1,
  red: -3,
  ownGoal: -2,
  per2Conceded: -1,
};
const SCORING_LABELS = {
  appearance: 'Appearance (under 60 min)',
  appearance60: 'Appearance (60+ min)',
  goalGK: 'Goal — GK', goalDF: 'Goal — DF', goalMF: 'Goal — MF', goalFW: 'Goal — FW',
  assist: 'Assist',
  cleanSheet: 'Clean sheet — GK/DF',
  cleanSheetMF: 'Clean sheet — MF',
  per3Saves: 'Every 3 saves — GK',
  penSave: 'Penalty save',
  penMiss: 'Penalty miss',
  yellow: 'Yellow card',
  red: 'Red card',
  ownGoal: 'Own goal',
  per2Conceded: 'Every 2 conceded — GK/DF',
};
// starting XI shape
const XI_RULES = { size: 11, GK: [1, 1], DF: [3, 5], MF: [2, 5], FW: [1, 3] };

/* ---------------- The Committee (est. 2015, minutes unavailable) ---------------- */
const COMMITTEE_QUOTES = [
  'The Committee notes this pick with interest.',
  'A solid pick. Your ROI per gameweek improves marginally.',
  'Noted, logged, and screenshotted for use against you in May.',
  'The waiting list — ten years deep — would have picked better.',
  'Conway says he doesn’t care (hate it).',
  'Singer says it’s only a game and doesn’t really matter BUT—',
  'Blanky reminds the room it’s all irrelevant post GW10.',
  'Lee asks why he wasn’t consulted. The fraternity remains democratic.',
  'Stick that one in your Monzo savings pot.',
  'The Committee has seen worse. The Committee has minutes proving it.',
];
const committeeSays = () => `The Committee: “${COMMITTEE_QUOTES[Math.floor(Math.random() * COMMITTEE_QUOTES.length)]}”`;

const INTERCEPTS = [
  '{name} is on the clock. The group chat has already moved on to discussing his mistake.',
  'Eleven managers watch {name} type… stop typing… and type again.',
  '{name} has three tabs open and none of them are helping.',
  'Sources close to {name} confirm the plan was abandoned two picks ago.',
  'The autodraft list watches {name} silently. Judging. (RIP Lints.)',
  '{name} once spent ten years on the waiting list for this. Worth it, apparently.',
  'A £4.0 defender trembles somewhere as {name} deliberates.',
  '{name} is consulting the same podcast as everyone else. The edge is imaginary.',
  'Committee reminder for {name}: it’s only a game and doesn’t really matter BUT—',
  '{name} hesitates. Somewhere, Blanky mutters that it’s all irrelevant post GW10.',
];
const interceptFor = (n, name) =>
  INTERCEPTS[n % INTERCEPTS.length].replaceAll('{name}', name);

const WEEKLY_MINUTES = [
  'COMMITTEE MINUTES — {L} tops the table and has already drafted the acceptance speech. {B} has enquired about the Chumpionship. The Chumpionship no longer exists.',
  'COMMITTEE MINUTES — {L}’s form is noted “with suspicion”. {B}’s ROI per gameweek has been recalculated and it’s upsetting.',
  'COMMITTEE MINUTES — {L} claims it’s all about process. {B} claims it’s all irrelevant post GW10. One of them is coping.',
  'COMMITTEE MINUTES — the waiting list (est. wait: 10 years) has submitted a formal complaint that {B} is wasting a seat.',
  'COMMITTEE MINUTES — {L} has been reported to the Committee for competence. {B} remains under no such suspicion.',
];
const investigationLine = (L, B) => {
  const day = new Date().getDate();
  return WEEKLY_MINUTES[day % WEEKLY_MINUTES.length].replaceAll('{L}', L).replaceAll('{B}', B);
};

/* ---------------- gameweeks ---------------- */
// Generated from the FPL API — a gameweek runs from its deadline to the next one's
const GAMEWEEKS = GAMEWEEKS_RAW.map(g => ({ n: g.n, label: g.label, from: g.deadline, to: g.to, finished: g.finished }));
const REGULAR_GWS = 33; // GW33 ends the regular season; GW34–36 are the playoffs
const CUP_START = 7;    // the Monzo Cup begins GW8 (index 7)
const gwFrom = i => GAMEWEEKS[i].from;
function currentGwIndex() {
  const now = Date.now();
  for (let i = 0; i < GAMEWEEKS.length; i++) if (now < new Date(GAMEWEEKS[i].to).getTime()) return i;
  return GAMEWEEKS.length - 1;
}
const gwIsOver = i => GAMEWEEKS[i].finished || Date.now() > new Date(GAMEWEEKS[i].to).getTime();
const gwHasStarted = i => Date.now() > new Date(gwFrom(i)).getTime();
// stats for a gameweek land under key 'gw{n}' — no date-window matching needed
const gwEvent = i => state.matchStats[`gw${GAMEWEEKS[i].n}`];
// round robin (circle method): 11 unique rounds for 12 managers, repeated three times
function pairingsFor(i) {
  if (i >= REGULAR_GWS) return []; // playoffs — bracket handled separately
  const o = state.draft.order.length ? state.draft.order : state.managers.map(m => m.id);
  const n = o.length;
  if (n < 2) return [];
  const r = i % (n - 1);
  const rest = o.slice(1);
  const rot = rest.slice(r).concat(rest.slice(0, r));
  const line = [o[0], ...rot];
  const pairs = [];
  for (let k = 0; k < Math.floor(n / 2); k++) pairs.push([line[k], line[n - 1 - k]]);
  // first team = home; alternate by round so the three meetings split 2-1
  return i % 2 ? pairs.map(([a, b]) => [b, a]) : pairs;
}

/* ---------------- state ---------------- */
let state = load() || freshState();

/* ---------------- multiplayer (Firebase sync) ---------------- */
const SYNC_OFF = new URLSearchParams(location.search).has('nosync');
const WHO_KEY = 'tl2627-whoami';
let whoami = +localStorage.getItem(WHO_KEY) || null; // manager id, -1 = spectator
let syncConnected = false;
let demoMode = false;
let demoBackup = null;
const syncOn = () => !SYNC_OFF && !!window.WCSync;
const netOn = () => syncOn() && !demoMode;
const isCommissioner = () => whoami === state.managers[0]?.id;
const canActFor = mid => demoMode || !syncOn() || whoami === mid || isCommissioner();
// use for actions: blocks other managers, and makes the commissioner explicitly
// confirm before touching a team that isn't theirs (no more accidents)
function actGuard(mid, what = 'team') {
  if (!canActFor(mid)) { toast(`That's ${managerName(mid)}'s ${what}, not yours`); return false; }
  if (netOn() && !demoMode && whoami !== mid && isCommissioner()) {
    return confirm(`COMMISSIONER OVERRIDE — you are changing ${managerName(mid)}'s ${what}, not your own. Proceed?`);
  }
  return true;
}

const SHARED_KEYS = ['phase', 'managers', 'settings', 'draft', 'lineups', 'transfers', 'trades', 'covenants', 'claims', 'waiverMeta', 'autolists', 'pins', 'adjustments', 'shirtNums', 'draftPool', 'windowDraft', 'tradeBlock', 'benchOrders', 'lobus', 'hamCup'];
function sharedSnapshot() {
  const o = {};
  for (const k of SHARED_KEYS) o[k] = state[k];
  return o;
}
function pushShared(path, val) {
  if (netOn()) window.WCSync.set(path, val).catch(e => console.warn('[sync] write failed', e));
}
function publishAll() {
  if (!netOn()) return;
  // per-key writes — a device still running an older build can never clobber
  // newer keys it doesn't know about (root set would silently drop them)
  for (const k of SHARED_KEYS) {
    window.WCSync.set(k, state[k] ?? null).catch(e => console.warn('[sync] publish failed', k, e));
  }
}
const toArr = x => Array.isArray(x) ? x : (x ? Object.values(x) : []);

window.onSharedSnapshot = data => {
  if (SYNC_OFF || demoMode) return;
  if (!data) {
    // cloud league is empty. Only the commissioner's device may repopulate it;
    // everyone else treats empty cloud as the truth (so a deliberate reset sticks).
    if (state.phase !== 'setup') {
      if (isCommissioner()) {
        if (confirm('The cloud league is empty but this device holds a game. Restore it for everyone? (Cancel = start fresh)')) {
          publishAll();
        } else {
          state = freshState();
          localStorage.removeItem('tl2627-ceremony-seen');
          save();
        }
      } else {
        state = freshState();
        localStorage.removeItem('tl2627-ceremony-seen');
        save();
      }
    }
    render();
    return;
  }
  data.managers = toArr(data.managers);
  data.draft = data.draft || {};
  data.draft.order = toArr(data.draft.order);
  data.draft.picks = toArr(data.draft.picks);
  data.draft.breaksDone = toArr(data.draft.breaksDone);
  data.draft.paused = !!data.draft.paused;
  // first sight of a fresh draft on this device → roll the opening ceremony
  const fresh = data.phase === 'draft' && data.draft.picks.length === 0;
  data.transfers = toArr(data.transfers);
  data.trades = toArr(data.trades);
  data.covenants = toArr(data.covenants);
  data.pins = data.pins || {};
  data.autolists = data.autolists || {};
  for (const mid of Object.keys(data.autolists)) data.autolists[mid] = toArr(data.autolists[mid]);
  data.lineups = data.lineups || {};
  for (const mid of Object.keys(data.lineups)) {
    data.lineups[mid] = data.lineups[mid] || {};
    for (const gw of Object.keys(data.lineups[mid])) data.lineups[mid][gw] = toArr(data.lineups[mid][gw]);
  }
  data.claims = data.claims || {};
  for (const gw of Object.keys(data.claims)) {
    for (const mid of Object.keys(data.claims[gw] || {})) data.claims[gw][mid] = toArr(data.claims[gw][mid]);
  }
  data.waiverMeta = data.waiverMeta || { lastRun: null, control: 'auto' };
  data.adjustments = data.adjustments || {};
  data.shirtNums = data.shirtNums || {};
  for (const k of SHARED_KEYS) if (data[k] !== undefined) state[k] = data[k];
  if (!state.settings.posMin) state.settings.posMin = { GK: 1, DF: 3, MF: 3, FW: 1 };
  if (!state.settings.posMax) state.settings.posMax = { GK: 2, DF: 6, MF: 6, FW: 4 };
  save(); render();
  const cerKey = state.draft.order.join('-');
  if (fresh && cerKey && localStorage.getItem('tl2627-ceremony-seen') !== cerKey) {
    localStorage.setItem('tl2627-ceremony-seen', cerKey);
    showCeremony();
  }
};
window.onSyncConnection = up => { syncConnected = up; renderSyncArea(); };

function freshState() {
  return {
    phase: 'setup', // setup | draft | season
    managers: [
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
    ],
    settings: {
      squadSize: 14,
      posMin: { GK: 1, DF: 3, MF: 3, FW: 1 }, // flex squads: any 14 inside these bounds
      posMax: { GK: 2, DF: 6, MF: 6, FW: 4 },
      pickTimer: 30,
      scoring: { ...DEFAULT_SCORING },
    },
    draft: { order: [], picks: [], breaksDone: [], timewastes: {}, paused: false, pausedLeft: 0 },
    autolists: {},         // managerId -> [pid] ranked personal autopick list / shortlist
    pins: {},              // managerId -> salted SHA-256 of their PIN
    lineups: {},           // managerId -> { gwIndex: [pid x11] }
    shirtNums: {},         // managerId -> { pid: customNumber }
    transfers: [],         // [{managerId, outId, inId, gw, n, t, trade?, waiver?}]
    trades: [],            // [{id, from, to, give, get, terms?, status: pending|done|rejected|withdrawn, t}]
    covenants: [],         // the offline bits: [{id, from, to, text, t, gw}] — the register of nonsense
    claims: {},            // gwIndex -> { managerId: [{in, out}] ranked }
    waiverMeta: { lastRun: null, control: 'auto' }, // control: auto | open | closed
    draftPool: null,       // draft-night snapshot {at, ids: {pid: club}} — anyone outside it is a locked "new arrival"
    windowDraft: null,     // {status: live|done, order, turn, passes, picks} — post-window mini-draft of arrivals
    tradeBlock: {},        // managerId -> [pid] players publicly listed as available to trade
    benchOrders: {},       // managerId -> { gwIndex: [pid] } — auto-sub priority, leftmost first
    lobus: {},             // managerId -> pid — each manager's declared Lobus (ledger #1)
    hamCup: null,          // {gw, drawnAt, entries: {managerId: [pid x11]}} — the Palwin Ham Cup (ledger #6)
    fixtures: [],
    matchStats: {},        // 'gw{n}' -> { gw, label, date, final, playerStats: {pid:{min,st,sub,g,a,cs,gc,og,ps,pm,yc,rc,sv}} }
    adjustments: {},
    lastSync: null,
    view: 'draft',
  };
}
function save() {
  if (demoMode) return;
  // stats and fixtures re-fetch from the feed on load — persisting them would
  // balloon every save to multiple MB by spring and jank older phones
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...state, matchStats: {}, fixtures: [] }));
  } catch (e) { console.warn('[save]', e); }
}
// last season's FPL points (falls back to price until the new season's data rolls in)
const rating = p => p.rating || lastSeasonOf(p)?.pts || 0;

/* ---------------- demo mode ---------------- */
function buildDemoState() {
  const s = freshState();
  s.phase = 'season';
  s.view = 'team';
  // deterministic shuffle so every device shows the same demo
  s.draft.order = s.managers.map(m => m.id).sort((a, b) => ((a * 2654435761) % 97) - ((b * 2654435761) % 97));
  const sorted = [...PLAYERS].sort((a, b) => rating(b) - rating(a));
  const taken = new Set();
  const counts = {};
  s.managers.forEach(m => { counts[m.id] = { GK: 0, DF: 0, MF: 0, FW: 0 }; });
  const { squadSize, posMin, posMax } = s.settings;
  const canTake = (mid, p) => {
    const c = counts[mid];
    const size = c.GK + c.DF + c.MF + c.FW;
    if (size >= squadSize || c[p.pos] >= posMax[p.pos]) return false;
    let need = 0;
    for (const pos of ['GK', 'DF', 'MF', 'FW']) need += Math.max(0, posMin[pos] - c[pos] - (pos === p.pos ? 1 : 0));
    return need <= squadSize - size - 1;
  };
  const m = s.managers.length;
  const totalDemoPicks = squadSize * m;
  for (let n = 0; n < totalDemoPicks; n++) {
    const round = Math.floor(n / m), idx = n % m;
    const mid = round % 2 === 0 ? s.draft.order[idx] : s.draft.order[m - 1 - idx];
    const p = sorted.find(p => !taken.has(p.id) && canTake(mid, p));
    taken.add(p.id);
    counts[mid][p.pos]++;
    s.draft.picks.push({ managerId: mid, playerId: p.id, n: n + 1 });
  }
  // fabricate Gameweek 1 results for everyone drafted
  const ps = {};
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const pk of s.draft.picks) {
    const p = PLAYER_BY_ID[pk.playerId];
    const started = rnd() < 0.8;
    const mins = started ? (rnd() < 0.85 ? 90 : 55) : (rnd() < 0.6 ? 25 : 0);
    const goalChance = { FW: 0.35, MF: 0.2, DF: 0.07, GK: 0.005 }[p.pos];
    const cs = p.pos !== 'FW' && mins >= 60 && rnd() < 0.35 ? 1 : 0;
    ps[p.id] = {
      min: mins,
      st: started ? 1 : 0,
      sub: !started && mins > 0 ? 1 : 0,
      g: mins > 0 && rnd() < goalChance ? (rnd() < 0.2 ? 2 : 1) : 0,
      a: mins > 0 && rnd() < 0.18 ? 1 : 0,
      cs,
      gc: !cs && mins >= 60 && p.pos !== 'FW' && rnd() < 0.5 ? Math.ceil(rnd() * 3) : 0,
      og: 0,
      ps: p.pos === 'GK' && mins > 0 && rnd() < 0.04 ? 1 : 0,
      pm: 0,
      yc: mins > 0 && rnd() < 0.12 ? 1 : 0,
      rc: mins > 0 && rnd() < 0.01 ? 1 : 0,
      sv: p.pos === 'GK' && mins > 0 ? Math.floor(rnd() * 7) : 0,
    };
  }
  s.matchStats = { gw1: { gw: 0, label: 'Demo — fictional Gameweek 1', date: GAMEWEEKS[0]?.from || '2026-08-15T17:30Z', final: true, playerStats: ps } };
  s.lastSync = new Date().toISOString();
  // the new toys, pre-loaded so the demo shows them all off
  const demoSquad = mid => s.draft.picks.filter(pk => pk.managerId === mid).map(pk => PLAYER_BY_ID[pk.playerId]);
  for (const mgr of s.managers) {
    if (rnd() < 0.25) continue; // a few holdouts, for the shame list
    const sq2 = demoSquad(mgr.id);
    const lob = sq2.filter(p => p.pos === 'FW').sort((a, b) => rating(b) - rating(a))[0] || sq2[0];
    s.lobus[mgr.id] = lob.id;
  }
  const freeAll = PLAYERS.filter(p => !taken.has(p.id)).sort((a, b) => rating(b) - rating(a));
  const freeBy = pos => freeAll.filter(p => p.pos === pos);
  s.hamCup = { gw: 8, drawnAt: new Date().toISOString(), entries: {} };
  [1, 4, 5, 8, 11].forEach((mid, k) => {
    s.hamCup.entries[mid] = [
      ...freeBy('GK').slice(k, k + 1), ...freeBy('DF').slice(k * 4, k * 4 + 4),
      ...freeBy('MF').slice(k * 4, k * 4 + 4), ...freeBy('FW').slice(k * 2, k * 2 + 2),
    ].map(p => p.id);
  });
  s.covenants = [
    { id: 1, from: 5, to: 8, text: 'Tussie holds first refusal on any City player Marc drops, in perpetuity.', t: Date.now(), gw: 0 },
    { id: 2, from: 3, to: 9, text: 'The Haaland curse shall not be mentioned before 9pm on matchdays.', t: Date.now(), gw: 0 },
  ];
  s.tradeBlock = { 2: [s.draft.picks.find(pk => pk.managerId === 2).playerId] };
  return s;
}
let vidiStash = null;
async function enterDemo() {
  if (demoMode) return;
  demoBackup = state;
  demoMode = true;
  state = buildDemoState();
  // a live-looking Vidiprinter tape from real drafted names (memory only —
  // the device's real tape is stashed and restored on exit)
  const dsq = mid => state.draft.picks.filter(pk => pk.managerId === mid).map(pk => PLAYER_BY_ID[pk.playerId]);
  const dfw = mid => dsq(mid).find(p => p.pos === 'FW') || dsq(mid)[0];
  const ddf = mid => dsq(mid).find(p => p.pos === 'DF') || dsq(mid)[0];
  vidiStash = vidiFeed;
  vidiFeed = [
    { txt: `⚽ 2 GOALS · 🅰️ assist — ${dfw(8).name} (${dfw(8).club}) — ${teamName(8)} +13 (13!!)` },
    { txt: `⚽ GOAL — ${dfw(5).name} (${dfw(5).club}) — ${teamName(5)} +5` },
    { txt: `🟥 RED CARD — ${ddf(3).name} (${ddf(3).club}) — ${teamName(3)} -3` },
    { txt: `🟨 booked — ${ddf(1).name} (${ddf(1).club}) — ${teamName(1)} -1` },
    { txt: `⚽ GOAL — ${dfw(12).name} (${dfw(12).club}) — benched by ${teamName(12)} (!)` },
  ].map((x, i) => ({ ts: Date.now() - (i + 2) * 7 * 60 * 1000, gw: 1, ...x }));
  render();
  toast('Demo mode — fake draft, fake results. Your real league is untouched.');
  // pull the full real season in, so every feature has something to show
  try {
    const bust = `?t=${Date.now()}`;
    const [stats, fixtures] = await Promise.all([
      fetch(`data/stats.json${bust}`).then(r => r.json()),
      fetch(`data/fixtures.json${bust}`).then(r => r.json()),
    ]);
    if (!demoMode) return;
    state.fixtures = fixtures.filter(f => f.date).sort((a, b) => a.date.localeCompare(b.date));
    for (const [gwN, gw] of Object.entries(stats.gws || {})) {
      const i = +gwN - 1;
      if (!GAMEWEEKS[i]) continue;
      state.matchStats[`gw${gwN}`] = { gw: i, label: GAMEWEEKS[i].label, date: GAMEWEEKS[i].from, final: !!gw.finished, playerStats: gw.stats || {} };
    }
    render();
    toast('Demo loaded a full season of real stats — click around, everything is live.');
  } catch { /* offline demo still works with its fictional GW1 */ }
}
function exitDemo() {
  state = demoBackup || load() || freshState();
  demoMode = false;
  demoBackup = null;
  if (vidiStash !== null) { vidiFeed = vidiStash; vidiStash = null; }
  render();
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && !s.lineups) { s.lineups = {}; s.transfers = []; } // migrate pre-lineup saves
    if (s && !s.claims) s.claims = {};
    if (s && !s.autolists) s.autolists = {};
    if (s && !s.trades) s.trades = [];
    if (s && !s.pins) s.pins = {};
    if (s && !s.covenants) s.covenants = [];
    if (s && !s.waiverMeta) s.waiverMeta = { lastRun: null, control: 'auto' };
    if (s && !s.shirtNums) s.shirtNums = {};
    if (s && s.draftPool === undefined) s.draftPool = null;
    if (s && s.windowDraft === undefined) s.windowDraft = null;
    if (s && !s.tradeBlock) s.tradeBlock = {};
    if (s && !s.benchOrders) s.benchOrders = {};
    if (s && !s.lobus) s.lobus = {};
    if (s && s.hamCup === undefined) s.hamCup = null;
    if (s && s.settings.pickTimer == null) s.settings.pickTimer = 30;
    if (s && !s.settings.posMin) s.settings.posMin = { GK: 1, DF: 3, MF: 3, FW: 1 };
    if (s && !s.settings.posMax) s.settings.posMax = { GK: 2, DF: 6, MF: 6, FW: 4 };
    return s;
  } catch { return null; }
}

/* ---------------- helpers ---------------- */
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// club badge — keeps the old flagImg name so every call site works unchanged
const flagImg = (team, big = false) => {
  const t = TEAM_BY_NAME[team];
  return t ? `<img class="flag${big ? ' big' : ''}" loading="lazy" src="https://resources.premierleague.com/premierleague/badges/70/t${t.code}.png" alt="${esc(team)}" title="${esc(team)}">` : '';
};
// official PL headshot, falling back to the league's own "Photo Missing" card.
// data-pcard makes every photo a button that opens the player's stats card.
const photoImg = p => `<img class="headshot" loading="lazy" data-pcard="${p.id}" src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" onerror="this.onerror=null;this.src='https://resources.premierleague.com/premierleague/photos/players/110x140/Photo-Missing.png'" alt="${esc(p.name)}" title="${esc(p.name)} — tap for stats">`;
// the actual kit artwork FPL uses (GK variant for keepers); pass p to make it clickable too
const kitImg = (team, gk = false, p = null) => {
  const t = TEAM_BY_NAME[team];
  return t ? `<img class="kit" loading="lazy"${p ? ` data-pcard="${p.id}"` : ''} src="https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_${t.code}${gk ? '_1' : ''}-66.png" alt="${esc(team)}" title="${p ? esc(p.name) + ' — tap for stats' : esc(team)}">` : '';
};
// next fixture for a club in a gameweek — "MCI (H)" style
function nextOpp(club, gwN) {
  const f = state.fixtures.find(f => f.gw === gwN && (f.home === club || f.away === club));
  if (!f) return null;
  const opp = f.home === club ? f.away : f.home;
  return `${TEAM_BY_NAME[opp]?.short || opp} (${f.home === club ? 'H' : 'A'})`;
}
// fixture difficulty at a glance — green means get them on, red means brace
const fdrCls = opp => { const s = TEAM_BY_NAME[opp]?.str || 1150; return s >= 1240 ? 'fdr-hard' : s <= 1100 ? 'fdr-easy' : ''; };
// coloured fixture chip for the pitch views
function nextOppHtml(club, gwN) {
  const f = state.fixtures.find(f => f.gw === gwN && (f.home === club || f.away === club));
  if (!f) return '—';
  const opp = f.home === club ? f.away : f.home;
  return `<span class="${fdrCls(opp)}">${esc(`${TEAM_BY_NAME[opp]?.short || opp} (${f.home === club ? 'H' : 'A'})`)}</span>`;
}
// clickable player name — opens the stats card, usable in any text row
const pname = p => p ? `<span class="plink" data-pcard="${p.id}">${esc(p.name)}</span>` : '?';
// expected points next gameweek: FPL's own projection, then points-per-game, then a guess
const playerXp = p => (p.xp > 0 ? p.xp : p.ppg > 0 ? p.ppg : p.pts > 0 ? p.pts / 38 : lastSeasonOf(p)?.ppg || p.price / 4);
const projectedGwScore = (mid, gwIdx) =>
  Math.round(lineupFor(mid, gwIdx).reduce((t, pid) => t + playerXp(PLAYER_BY_ID[pid]), 0));
// win chance from the projected-score gap (logistic; ~12-point gap ≈ 70%)
const winChance = (sa, sb) => 1 / (1 + Math.pow(10, -(sa - sb) / 25));

/* ----- live win probability -----
   Each player still to play contributes expected points plus uncertainty;
   as fixtures run, uncertainty drains and banked points take over.
   Even teams before kickoff = exactly 50:50; final whistle = 100:0. */
const PLAYER_SD = 4; // one player's gameweek points spread
function playerFixtureState(p, gwN) {
  const f = state.fixtures.find(f => f.gw === gwN && (f.home === p.team || f.away === p.team));
  // no fixture DATA at all for this GW (failed fetch, not yet synced): assume everyone is
  // still to play rather than letting the win bar collapse to a false 100–0
  if (!f) return { st: 'none', frac: state.fixtures.some(x => x.gw === gwN) ? 0 : 1 };
  if (f.finished) return { st: 'done', frac: 0 };
  if (f.started) return { st: 'live', frac: Math.max(0, (90 - Math.min(90, f.minutes || 0)) / 90) };
  return { st: 'pre', frac: 1 };
}
function teamOutlook(mid, i) {
  const gwN = GAMEWEEKS[i].n;
  let exp = 0, varsum = 0, toPlay = 0;
  for (const pid of effectiveXI(mid, i).xi) {
    const p = PLAYER_BY_ID[pid];
    const cur = gwPlayerPoints(pid, i);
    const fs = playerFixtureState(p, gwN);
    exp += cur + playerXp(p) * fs.frac;
    varsum += PLAYER_SD * PLAYER_SD * fs.frac;
    if (fs.frac > 0) toPlay++;
  }
  return { exp, varsum, toPlay };
}
function liveWinProb(a, b, i) {
  const A = teamOutlook(a, i), B = teamOutlook(b, i);
  const diff = A.exp - B.exp;
  const sigma = Math.sqrt(A.varsum + B.varsum);
  if (sigma < 0.5) return diff > 0 ? 1 : diff < 0 ? 0 : 0.5;
  const z = diff / sigma;
  // Φ(z), Abramowitz–Stegun
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3194815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  p = z > 0 ? 1 - p : p;
  // never claim certainty while either side still has football to play
  if (A.toPlay + B.toPlay > 0) p = Math.min(0.99, Math.max(0.01, p));
  return p;
}
// injury/availability chip from the FPL status flag
const STATUS_ICON = { d: '⚠️', i: '🏥', s: '🟥', u: '🚫', n: '🚫' };
const statusChip = p => STATUS_ICON[p.status]
  ? `<span class="status-chip" title="${esc(p.news || 'Unavailable')}">${STATUS_ICON[p.status]}</span>` : '';
// red ring/tint for the crocked and banned, amber for doubts — used on chips and table rows
const statusClass = p => p.status === 'a' ? '' : p.status === 'd' ? 'st-amber' : 'st-red';
function toast(msg) {
  const el = $('#toast') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'toast' }));
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}
function normName(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function managerName(mid) { return state.managers.find(m => m.id === mid)?.name || `Manager ${mid}`; }
function teamName(mid) { const m = state.managers.find(m => m.id === mid); return m?.team || m?.name || `Manager ${mid}`; }
// default grounds, until the owner sells the naming rights (tap the stadium name on My Team)
const DEFAULT_STADIA = {
  1: 'The Kennel',                                // The Dog's Polaks
  2: 'The Great Hall of the People',              // Chairman Mao *°
  3: 'El Benfield Metropolitano',                 // Atlético Benfield
  4: 'Stadio Giuseppe Jackson',                   // Interjacksonale*
  5: 'The Khusanova Arena (naming rights disputed)', // Champagne Khusanova FC
  6: 'The Hot Gates',                             // Singer's Spartans
  7: 'The Asterisk Bowl*',                        // Asterick
  8: 'The Motherboard',                           // 101011101
  9: 'The Pond',                                  // Mighty 🦆 *
  10: 'Balaídos-upon-Leigh',                      // Celta Leigh-Go
  11: 'The Dog Track',                            // Geldog FC
  12: 'The WACA',                                 // WA Wanderers
};
function stadium(mid) { const m = state.managers.find(m => m.id === mid); return m?.stadium || DEFAULT_STADIA[mid] || `${teamName(mid)} Park`; }
// pitch-side hoardings — the league's proud commercial partners, rotating each week
function adStrip(seed, n = 3) {
  if (typeof AD_BOARDS === 'undefined' || !AD_BOARDS.length) return '';
  let s = (seed * 2654435761) % 2147483648;
  const pool = AD_BOARDS.map((_, i) => i);
  const picks = [];
  for (let k = 0; k < Math.min(n, pool.length); k++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    picks.push(pool.splice(s % pool.length, 1)[0]);
  }
  return `<div class="ad-strip">${picks.map(i => {
    const b = AD_BOARDS[i];
    return `<span class="ad-board" style="color:${b.c};background:${b.bg}"><b>${b.t}</b><i>${b.s}</i></span>`;
  }).join('')}</div>`;
}
// matchday attendance: deterministic per fixture, so every device reports the same crowd
function attendance(a, b, i) {
  let s = a * 7919 + b * 104729 + i * 1299709;
  s = (s * 1103515245 + 12345) % 2147483648;
  return 8000 + (s % 34000);
}

/* ---------------- rosters (draft + transfers) ---------------- */
function squadAt(mid, gwIdx) {
  const ids = new Set(state.draft.picks.filter(p => p.managerId === mid).map(p => p.playerId));
  for (const t of state.transfers) {
    if (t.managerId !== mid || t.gw > gwIdx) continue;
    ids.delete(t.outId);
    ids.add(t.inId);
  }
  return [...ids].map(id => PLAYER_BY_ID[id]);
}
function managerSquad(mid) { return squadAt(mid, currentGwIndex()); }
function posCount(mid) {
  const c = { GK: 0, DF: 0, MF: 0, FW: 0 };
  managerSquad(mid).forEach(p => c[p.pos]++);
  return c;
}
function ownedIdsAt(gwIdx) {
  const ids = new Set();
  for (const m of state.managers) for (const p of squadAt(m.id, gwIdx)) ids.add(p.id);
  return ids;
}
// flex squads: any 14 inside per-position min/max bounds. No club cap —
// Tussie's right to draft the entire City team by GW30 is constitutionally protected.
function squadShapeOk(squad) {
  const c = { GK: 0, DF: 0, MF: 0, FW: 0 };
  squad.forEach(p => c[p.pos]++);
  const { posMin, posMax } = state.settings;
  return ['GK', 'DF', 'MF', 'FW'].every(pos => c[pos] >= posMin[pos] && c[pos] <= posMax[pos]);
}
function shirtNum(mid, pid) {
  return state.shirtNums?.[mid]?.[pid] ?? '–';
}

/* ---------------- waivers & the Trough (Draft Fantasy mechanics) ----------------
   Everyone goes on waivers when a gameweek starts; dropped players go on waivers.
   Claims are ranked and blind. Waivers process Tue & Fri 10:00 UTC (or whenever
   the Chairman says so); order = reverse standings, winners drop to the back.
   Whatever clears waivers is free in the Trough — first come, first served. */

// next scheduled processing after a given time: Tue & Fri 10:00 UTC
function nextWaiverRun(afterTs) {
  const d = new Date(afterTs);
  for (let k = 0; k < 9; k++) {
    const c = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + k, 10, 0, 0));
    if (c.getTime() > d.getTime() && [2, 5].includes(c.getUTCDay())) return c;
  }
  return new Date(d.getTime() + 3 * 864e5);
}
const waiverControl = () => state.waiverMeta?.control || 'auto';
const lastWaiverRun = () => state.waiverMeta?.lastRun ? new Date(state.waiverMeta.lastRun).getTime() : 0;
function waiverRunDue() {
  if (state.phase !== 'season' || waiverControl() !== 'auto') return false;
  const anchor = lastWaiverRun() || new Date(gwFrom(0)).getTime();
  return Date.now() > nextWaiverRun(anchor).getTime();
}
// is this player currently stuck on waivers (claim-only), or free to sign now?
function onWaivers(p) {
  const ctl = waiverControl();
  if (ctl === 'open') return false;
  if (ctl === 'closed') return true;
  const cur = currentGwIndex();
  // the gameweek starting locks everyone until the next processing
  if (gwHasStarted(cur) && lastWaiverRun() < new Date(gwFrom(cur)).getTime()) return true;
  // recently dropped players wait for the next processing
  for (const t of state.transfers) {
    if (t.outId === p.id && (t.t || 0) > lastWaiverRun()) return true;
  }
  return false;
}

/* ---------------- new arrivals & the Window Draft ----------------
   League tradition: anyone who joins a PL club after draft night is locked
   until the transfer window shuts. The Chairman then runs the Window Draft —
   snaking backwards from the original order (pick 12 goes first) until a full
   lap of passes — and whatever's left spills into the Trough. */
const isArrival = p => !!state.draftPool?.ids && state.draftPool.ids[p.id] !== p.club;
const arrivalLocked = p => isArrival(p); // unlocks when the Window Draft ends (snapshot refreshes)
function lockedArrivals() {
  if (!state.draftPool?.ids) return [];
  const owned = ownedIdsAt(currentGwIndex());
  return PLAYERS.filter(p => isArrival(p) && !owned.has(p.id));
}
function wdActor() {
  const wd = state.windowDraft, ord = wd.order;
  const lap = Math.floor(wd.turn / ord.length), i = wd.turn % ord.length;
  return lap % 2 === 0 ? ord[i] : ord[ord.length - 1 - i];
}
function wdAdvance(passed) {
  const wd = state.windowDraft;
  wd.passes = passed ? (wd.passes || 0) + 1 : 0;
  wd.turn++;
  if (wd.passes >= wd.order.length || !lockedArrivals().length) { wdFinish(); return; }
  pushShared('windowDraft', state.windowDraft);
  save(); render();
}
function wdFinish() {
  if (state.windowDraft) state.windowDraft = { ...state.windowDraft, status: 'done' };
  // refresh the snapshot: every remaining arrival unlocks into the Trough
  state.draftPool = { at: Date.now(), ids: Object.fromEntries(PLAYERS.map(p => [p.id, p.club])) };
  pushShared('windowDraft', state.windowDraft);
  pushShared('draftPool', state.draftPool);
  save(); render();
  toast('The window business is done — anyone left is loose in the Trough.');
}
function myClaims(mid) { return toArr(state.claims?.[currentGwIndex()]?.[mid]); }
function setClaims(mid, arr) {
  const cur = currentGwIndex();
  (state.claims[cur] = state.claims[cur] || {})[mid] = arr;
  pushShared(`claims/${cur}/${mid}`, arr);
  save(); render();
}
// commissioner-only: resolve all pending claims, then open the Trough
function processWaivers(manual = false) {
  if (netOn() && !isCommissioner()) { toast('Only the Chairman runs waivers'); return; }
  const cur = currentGwIndex();
  const claimsByMid = state.claims?.[cur] || {};
  const queue = waiverOrder(cur); // reverse standings — weekly reset
  const pending = {};
  for (const mid of queue) pending[mid] = [...toArr(claimsByMid[mid])];
  const executed = [];
  const touchedLineups = new Set();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let qi = 0; qi < queue.length; qi++) {
      const mid = queue[qi];
      while (pending[mid].length) {
        const c = pending[mid].shift();
        const inP = PLAYER_BY_ID[c.in];
        if (!inP || ownedIdsAt(cur).has(c.in)) continue;              // gone — try next claim
        if (!managerSquad(mid).some(x => x.id === c.out)) continue;   // out-player no longer theirs
        if (!squadShapeOk([...squadAt(mid, cur).filter(x => x.id !== c.out), inP])) continue;
        state.transfers.push({ managerId: mid, outId: c.out, inId: c.in, gw: cur, n: state.transfers.length + 1, t: Date.now(), waiver: true });
        const lu = state.lineups[mid]?.[cur];
        if (lu) { state.lineups[mid][cur] = lu.filter(id => id !== c.out); touchedLineups.add(mid); }
        executed.push({ mid, in: c.in, out: c.out });
        queue.splice(qi, 1); queue.push(mid); // winner drops to the back
        progressed = true;
        break;
      }
      if (progressed) break;
    }
  }
  state.claims[cur] = {};
  state.waiverMeta = { ...state.waiverMeta, lastRun: new Date().toISOString() };
  pushShared(`claims/${cur}`, null);
  pushShared('waiverMeta', state.waiverMeta);
  pushShared('transfers', state.transfers);
  for (const mid of touchedLineups) pushShared(`lineups/${mid}/${cur}`, state.lineups[mid][cur]);
  save(); render();
  toast(executed.length
    ? `Waivers processed — ${executed.map(e => `${managerName(e.mid)} lands ${PLAYER_BY_ID[e.in]?.name}`).join(', ')}. The Trough is open.`
    : `Waivers processed — no claims landed. The Trough is open.`);
}
function setWaiverControl(mode) {
  if (netOn() && !isCommissioner()) { toast('Only the Chairman controls the Trough'); return; }
  state.waiverMeta = { ...state.waiverMeta, control: mode };
  pushShared('waiverMeta', state.waiverMeta);
  save(); render();
  toast(mode === 'open' ? 'The Trough is thrown open — everything is free to sign.'
    : mode === 'closed' ? 'The Trough is closed. The Chairman has spoken.'
    : 'Back on schedule — waivers Tue & Fri, 10:00 UTC.');
}
// standings using ONLY gameweeks final before gwIdx — deterministic, can't reshuffle mid-round
function standingsBefore(gwIdx) {
  const rows = state.managers.map(m => ({ id: m.id, h2h: 0, pts: 0 }));
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  let anyFinal = false;
  for (let i = 0; i < Math.min(gwIdx, REGULAR_GWS); i++) {
    if (gwStatus(i) !== 'final') continue;
    anyFinal = true;
    for (const r of rows) r.pts += gwManagerPoints(r.id, i);
    for (const [a, b] of pairingsFor(i)) {
      const pa = gwManagerPoints(a, i), pb = gwManagerPoints(b, i);
      if (pa > pb) byId[a].h2h += 3;
      else if (pb > pa) byId[b].h2h += 3;
      else { byId[a].h2h++; byId[b].h2h++; }
    }
  }
  rows.sort((x, y) => y.h2h - x.h2h || y.pts - x.pts || x.id - y.id);
  return { rows, anyFinal };
}
function waiverOrder(gwIdx) {
  const { rows, anyFinal } = standingsBefore(gwIdx);
  const base = anyFinal ? rows.map(r => r.id) : [...state.draft.order];
  return [...base].reverse(); // bottom feeds first
}
/* ---------------- trades (Draft Fantasy style: propose, accept, done) ---------------- */
// trades carry give/get as ARRAYS (equal counts). Old single-id offers still parse.
const tGive = t => toArr(t.give ?? []).length ? toArr(t.give) : [t.give].filter(Boolean);
const tGet = t => toArr(t.get ?? []).length ? toArr(t.get) : [t.get].filter(Boolean);
const tradeNames = ids => ids.map(id => PLAYER_BY_ID[id]?.name || '?').join(' + ');
function proposeTrade(from, to, give, get, terms = '') {
  give = toArr(give); get = toArr(get);
  if (!give.length || give.length !== get.length) { toast('Trades swap the same number of players each way'); return; }
  state.trades = [...toArr(state.trades), { id: Date.now() + '-' + from, from, to, give, get, terms: terms.slice(0, 200), status: 'pending', t: Date.now() }];
  pushShared('trades', state.trades);
  save(); render();
  toast(`Trade proposed to ${managerName(to)}. Their move.`);
}
function respondTrade(id, accept) {
  const tr = toArr(state.trades).find(x => x.id === id);
  if (!tr || tr.status !== 'pending') return;
  if (!accept) {
    tr.status = 'rejected';
    pushShared('trades', state.trades);
    save(); render();
    toast('Trade rejected. Nothing personal. (It was personal.)');
    return;
  }
  const cur = currentGwIndex();
  const give = tGive(tr), get = tGet(tr);
  // validate at acceptance time — squads may have changed since the proposal
  if (give.some(pid => !managerSquad(tr.from).some(x => x.id === pid)) ||
      get.some(pid => !managerSquad(tr.to).some(x => x.id === pid))) {
    tr.status = 'withdrawn';
    pushShared('trades', state.trades);
    save(); render();
    toast('Trade void — a player involved has already moved on.');
    return;
  }
  const giveSet = new Set(give), getSet = new Set(get);
  const fromAfter = [...squadAt(tr.from, cur).filter(p => !giveSet.has(p.id)), ...get.map(pid => PLAYER_BY_ID[pid])];
  const toAfter = [...squadAt(tr.to, cur).filter(p => !getSet.has(p.id)), ...give.map(pid => PLAYER_BY_ID[pid])];
  if (!squadShapeOk(fromAfter) || !squadShapeOk(toAfter)) {
    toast('Trade would break a squad\'s position limits'); return;
  }
  tr.status = 'done';
  if (tr.terms) {
    state.covenants = [...toArr(state.covenants), { id: tr.id + '-cov', from: tr.from, to: tr.to, text: tr.terms, t: Date.now(), gw: GAMEWEEKS[cur].n }];
    pushShared('covenants', state.covenants);
  }
  for (let k = 0; k < give.length; k++) {
    state.transfers.push({ managerId: tr.from, outId: give[k], inId: get[k], gw: cur, n: state.transfers.length + 1, t: Date.now(), trade: true });
    state.transfers.push({ managerId: tr.to, outId: get[k], inId: give[k], gw: cur, n: state.transfers.length + 1, t: Date.now(), trade: true });
  }
  for (const [m2, gone] of [[tr.from, give], [tr.to, get]]) {
    const lu = state.lineups[m2]?.[cur];
    if (lu) {
      state.lineups[m2][cur] = lu.filter(pid => !gone.includes(pid));
      pushShared(`lineups/${m2}/${cur}`, state.lineups[m2][cur]);
    }
  }
  pushShared('trades', state.trades);
  pushShared('transfers', state.transfers);
  save(); render();
  toast(`Trade done: ${tradeNames(give)} ↔ ${tradeNames(get)}. Executed instantly, as is right and proper.`);
}

/* ---------------- draft logic ---------------- */
function totalPicks() { return state.managers.length * state.settings.squadSize; }
function pickNo() { return state.draft.picks.length; }
function currentManagerId() {
  const n = pickNo(), m = state.managers.length;
  if (n >= totalPicks()) return null;
  const round = Math.floor(n / m), idx = n % m;
  const order = state.draft.order;
  return (round % 2 === 0) ? order[idx] : order[m - 1 - idx];
}
function canPick(mid, player) {
  if (arrivalLocked(player)) return false; // new arrivals wait for the Window Draft
  const { squadSize, posMin, posMax } = state.settings;
  const c = posCount(mid);
  const size = managerSquad(mid).length;
  if (size >= squadSize || c[player.pos] >= posMax[player.pos]) return false;
  // the pick must leave enough slots to satisfy every unmet position minimum
  let need = 0;
  for (const pos of ['GK', 'DF', 'MF', 'FW']) need += Math.max(0, posMin[pos] - c[pos] - (pos === player.pos ? 1 : 0));
  return need <= squadSize - size - 1;
}
function draftedIds() { return new Set(state.draft.picks.map(p => p.playerId)); }

function makePick(playerId, force = false) {
  const mid = currentManagerId();
  if (mid == null) return;
  if (!force && !canActFor(mid)) { toast(`It's ${managerName(mid)}'s pick — the group chat is watching you`); return; }
  const player = PLAYER_BY_ID[playerId];
  if (!canPick(mid, player)) { toast(`${managerName(mid)} can't fit another ${player.pos} — position limits`); return; }
  const rec = { managerId: mid, playerId, n: pickNo() + 1 };
  const finishPick = total => {
    if (state.settings.pickTimer && total < totalPicks()) {
      state.draft.deadline = Date.now() + state.settings.pickTimer * 1000;
      pushShared('draft/deadline', state.draft.deadline);
    }
    if (total >= totalPicks()) {
      state.phase = 'season';
      if (whoami === mid) state.view = 'dash';
      pushShared('phase', 'season');
      toast('Draft complete. The Committee has ratified the minutes. Game on.');
    } else if (Math.random() < 0.3) {
      toast(committeeSays());
    }
    save(); render();
  };
  if (netOn()) {
    const expected = pickNo();
    window.WCSync.txn('draft/picks', cur => {
      const arr = toArr(cur);
      if (arr.length !== expected) return; // someone got there first — abort
      arr.push(rec);
      return arr;
    }).then(res => {
      if (!res.committed) { toast('Pick clashed — the board moved on'); return; }
      state.draft.picks = toArr(res.snapshot.val());
      finishPick(state.draft.picks.length);
    }).catch(e => { console.warn(e); toast('Pick failed to send — check connection'); });
  } else {
    state.draft.picks.push(rec);
    finishPick(state.draft.picks.length);
  }
}
function autoPick(force = false) {
  const mid = currentManagerId();
  if (mid == null) return;
  const taken = draftedIds();
  // the manager's own autopick list first, then best available by rating
  let best = toArr(state.autolists?.[mid]).map(id => PLAYER_BY_ID[id])
    .find(p => p && !taken.has(p.id) && canPick(mid, p));
  if (!best) best = PLAYERS.filter(p => !taken.has(p.id) && canPick(mid, p))
    .sort((a, b) => rating(b) - rating(a))[0];
  if (best) makePick(best.id, force);
}
function setAutolist(mid, arr) {
  state.autolists[mid] = arr;
  pushShared(`autolists/${mid}`, arr);
  save(); render();
}

/* ---------------- lineups ---------------- */
function autoXI(squad) {
  const by = pos => squad.filter(p => p.pos === pos).sort((a, b) => rating(b) - rating(a));
  const xi = [...by('GK').slice(0, 1), ...by('DF').slice(0, 4), ...by('MF').slice(0, 4), ...by('FW').slice(0, 2)];
  return xi.map(p => p.id);
}
function lineupFor(mid, gwIdx) {
  const squad = squadAt(mid, gwIdx);
  const squadIds = new Set(squad.map(p => p.id));
  const stored = state.lineups[mid] || {};
  let xi = null;
  if (stored[gwIdx]) xi = stored[gwIdx].filter(id => squadIds.has(id));
  else {
    for (let j = gwIdx - 1; j >= 0; j--) {
      if (stored[j]) { xi = stored[j].filter(id => squadIds.has(id)); break; }
    }
  }
  if (!xi) return autoXI(squad);
  // top up short lineups (e.g. a starter left via waiver/trade) with best legal players
  if (xi.length < XI_RULES.size) {
    const cands = squad.filter(p => !xi.includes(p.id)).sort((a, b) => rating(b) - rating(a));
    // satisfy position minimums first, then best available within maximums
    for (const pos of ['GK', 'DF', 'MF', 'FW']) {
      while (xi.length < XI_RULES.size && xiCounts(xi)[pos] < XI_RULES[pos][0]) {
        const c = cands.find(p => p.pos === pos && !xi.includes(p.id));
        if (!c) break;
        xi.push(c.id);
      }
    }
    for (const c of cands) {
      if (xi.length >= XI_RULES.size) break;
      if (!xi.includes(c.id) && xiCounts(xi)[c.pos] < XI_RULES[c.pos][1]) xi.push(c.id);
    }
  }
  return xi;
}
function xiCounts(pids) {
  const c = { GK: 0, DF: 0, MF: 0, FW: 0 };
  pids.forEach(id => c[PLAYER_BY_ID[id].pos]++);
  return c;
}
function xiValid(pids) {
  if (pids.length !== XI_RULES.size) return false;
  const c = xiCounts(pids);
  return ['GK', 'DF', 'MF', 'FW'].every(pos => c[pos] >= XI_RULES[pos][0] && c[pos] <= XI_RULES[pos][1]);
}

/* ---------------- scoring ---------------- */
// raw FPL gameweek stats -> league points, per the editable scoring table.
// FPL's cs/gc stats already respect the 60-minute / on-pitch rules.
function statPoints(player, s) {
  const sc = state.settings.scoring;
  const goalPts = { GK: sc.goalGK, DF: sc.goalDF, MF: sc.goalMF, FW: sc.goalFW }[player.pos] ?? sc.goalFW;
  const min = s.min ?? ((s.st || s.sub) ? 90 : 0);
  let pts = 0;
  if (min > 0) pts += min >= 60 ? sc.appearance60 : sc.appearance;
  pts += (s.g || 0) * goalPts + (s.a || 0) * sc.assist;
  pts += (s.og || 0) * sc.ownGoal + (s.pm || 0) * sc.penMiss;
  pts += (s.yc || 0) * sc.yellow + (s.rc || 0) * sc.red;
  if (player.pos === 'GK' || player.pos === 'DF') {
    pts += (s.cs || 0) * sc.cleanSheet;
    pts += Math.floor((s.gc || 0) / 2) * sc.per2Conceded;
  }
  if (player.pos === 'MF') pts += (s.cs || 0) * sc.cleanSheetMF;
  if (player.pos === 'GK') pts += Math.floor((s.sv || 0) / 3) * sc.per3Saves + (s.ps || 0) * sc.penSave;
  return pts;
}
function gwPlayerPoints(pid, gwIdx) {
  const s = gwEvent(gwIdx)?.playerStats?.[pid];
  return s ? statPoints(PLAYER_BY_ID[pid], s) : 0;
}
// did the player get on the pitch at all this gameweek?
function appearedInGw(pid, gwIdx) {
  const s = gwEvent(gwIdx)?.playerStats?.[pid];
  return !!(s && (s.min || s.st || s.sub));
}
// the bench in priority order: stored order first (carried forward like lineups),
// anyone unlisted appended by rating. Leftmost comes on first — Draft Fantasy style.
function benchFor(mid, gwIdx) {
  const xi = new Set(lineupFor(mid, gwIdx));
  const squad = squadAt(mid, gwIdx).filter(p => !xi.has(p.id));
  const stored = state.benchOrders?.[mid] || {};
  let ord = stored[gwIdx];
  if (!ord) for (let j = gwIdx - 1; j >= 0; j--) { if (stored[j]) { ord = stored[j]; break; } }
  ord = toArr(ord);
  const byId = Object.fromEntries(squad.map(p => [p.id, p]));
  const out = ord.filter(id => byId[id]).map(id => byId[id]);
  for (const p of [...squad].sort((a, b) => rating(b) - rating(a))) if (!out.includes(p)) out.push(p);
  return out;
}
function setBenchOrder(mid, gwIdx, pids) {
  (state.benchOrders = state.benchOrders || {})[mid] = state.benchOrders[mid] || {};
  state.benchOrders[mid][gwIdx] = pids;
  pushShared(`benchOrders/${mid}/${gwIdx}`, pids);
}
// auto-subs: starters who never played are replaced by bench players who did,
// best-rated first, keeping the XI shape legal
function effectiveXI(mid, gwIdx) {
  const xi = [...lineupFor(mid, gwIdx)];
  const ev = gwEvent(gwIdx);
  const anySynced = !!ev && Object.keys(ev.playerStats || {}).length > 0;
  if (!anySynced) return { xi, subs: [] };
  const bench = benchFor(mid, gwIdx).filter(p => appearedInGw(p.id, gwIdx)); // manager's order, leftmost first
  const subs = [];
  for (const pid of [...xi]) {
    if (appearedInGw(pid, gwIdx)) continue;
    const idx = xi.indexOf(pid);
    for (const cand of bench) {
      if (xi.includes(cand.id)) continue;
      const trial = [...xi];
      trial[idx] = cand.id;
      // swap must keep position counts inside the rules (length unchanged)
      const c = xiCounts(trial);
      const shapeOk = ['GK', 'DF', 'MF', 'FW'].every(pos => c[pos] >= XI_RULES[pos][0] && c[pos] <= XI_RULES[pos][1]);
      if (shapeOk) {
        xi[idx] = cand.id;
        subs.push({ out: pid, in: cand.id });
        break;
      }
    }
  }
  return { xi, subs };
}
function gwManagerPoints(mid, gwIdx) {
  const xi = effectiveXI(mid, gwIdx).xi;
  let pts = xi.reduce((t, pid) => t + gwPlayerPoints(pid, gwIdx), 0);
  // the Lobus honours his people (ledger #1) — only if the Committee turns the bonus on
  const bonus = +state.settings.lobusBonus || 0;
  if (bonus) {
    const lob = state.lobus?.[mid];
    const s = lob && xi.includes(lob) ? gwEvent(gwIdx)?.playerStats?.[lob] : null;
    if (s && (s.g || 0) + (s.a || 0) > 0) pts += bonus;
  }
  return pts;
}
// GWs in which a manager's Lobus scored or assisted from the starting XI
function lobusHonours(mid) {
  const lob = state.lobus?.[mid];
  if (!lob) return 0;
  let n = 0;
  for (let i = 0; i < GAMEWEEKS.length; i++) {
    const s = gwEvent(i)?.playerStats?.[lob];
    if (s && (s.g || 0) + (s.a || 0) > 0 && effectiveXI(mid, i).xi.includes(lob)) n++;
  }
  return n;
}
function managerPoints(mid) {
  let pts = 0;
  for (let i = 0; i < GAMEWEEKS.length; i++) {
    pts += gwManagerPoints(mid, i); // zero unless results exist in that window
  }
  const squadIds = new Set(managerSquad(mid).map(p => p.id));
  for (const [pid, adj] of Object.entries(state.adjustments)) {
    if (adj && squadIds.has(+pid)) pts += adj;
  }
  return pts;
}
// points a player has banked for this manager (only weeks he was in the XI)
function contributedPoints(mid, pid) {
  let pts = 0;
  for (let i = 0; i < GAMEWEEKS.length; i++) {
    if (effectiveXI(mid, i).xi.includes(pid)) pts += gwPlayerPoints(pid, i);
  }
  return pts + (state.adjustments[pid] || 0);
}
// raw all-season breakdown for tooltips / top players
function playerPoints(pid) {
  const p = PLAYER_BY_ID[pid];
  let pts = 0;
  const agg = { app: 0, g: 0, a: 0, cs: 0, sv: 0, ps: 0, pm: 0, yc: 0, rc: 0, og: 0 };
  for (const ev of Object.values(state.matchStats)) {
    const s = ev.playerStats?.[pid];
    if (!s) continue;
    pts += statPoints(p, s); // points computed per-gameweek, so the floors stay honest
    if (s.min || s.st || s.sub) agg.app++;
    for (const k of ['g', 'a', 'cs', 'sv', 'ps', 'pm', 'yc', 'rc', 'og']) agg[k] += (s[k] || 0);
  }
  const lines = [];
  const say = (n, label) => { if (n) lines.push(`${label} ${n}`); };
  say(agg.app, 'Apps'); say(agg.g, 'Goals'); say(agg.a, 'Assists');
  if (p.pos !== 'FW') say(agg.cs, 'Clean sheets');
  if (p.pos === 'GK') { say(agg.sv, 'Saves'); say(agg.ps, 'Pen saves'); }
  say(agg.yc, 'Yellows'); say(agg.rc, 'Reds'); say(agg.og, 'Own goals'); say(agg.pm, 'Pens missed');
  return { pts, agg, lines };
}

/* ---------------- bragging metrics: bench waste, luck, playoff odds ---------------- */
// the best legal XI a manager COULD have fielded that gameweek
function optimalXI(mid, gwIdx) {
  const byPos = { GK: [], DF: [], MF: [], FW: [] };
  for (const p of squadAt(mid, gwIdx)) byPos[p.pos].push(gwPlayerPoints(p.id, gwIdx));
  for (const k in byPos) byPos[k].sort((a, b) => b - a);
  const take = (arr, n) => arr.slice(0, n).reduce((t, x) => t + x, 0);
  let best = 0;
  for (let df = XI_RULES.DF[0]; df <= Math.min(XI_RULES.DF[1], byPos.DF.length); df++)
    for (let mf = XI_RULES.MF[0]; mf <= Math.min(XI_RULES.MF[1], byPos.MF.length); mf++) {
      const fw = XI_RULES.size - 1 - df - mf;
      if (fw < XI_RULES.FW[0] || fw > XI_RULES.FW[1] || fw > byPos.FW.length || !byPos.GK.length) continue;
      best = Math.max(best, take(byPos.GK, 1) + take(byPos.DF, df) + take(byPos.MF, mf) + take(byPos.FW, fw));
    }
  return best;
}
const benchWaste = (mid, gwIdx) => Math.max(0, optimalXI(mid, gwIdx) - gwManagerPoints(mid, gwIdx));
function seasonBenchWaste(mid) {
  let w = 0;
  for (let i = 0; i < REGULAR_GWS; i++) if (gwStatus(i) === 'final') w += benchWaste(mid, i);
  return w;
}
// all-play: your record if you'd played all eleven others every finished gameweek
function allPlayTable() {
  const rows = Object.fromEntries(state.managers.map(m => [m.id, { w: 0, d: 0, l: 0 }]));
  let played = 0;
  for (let i = 0; i < REGULAR_GWS; i++) {
    if (gwStatus(i) !== 'final') continue;
    played++;
    const scores = state.managers.map(m => [m.id, gwManagerPoints(m.id, i)]);
    for (const [id, s] of scores) for (const [oid, os] of scores) {
      if (id === oid) continue;
      if (s > os) rows[id].w++; else if (s < os) rows[id].l++; else rows[id].d++;
    }
  }
  return { rows, played };
}
// Monte Carlo the rest of the regular season from each manager's scoring history
function playoffOdds(runs = 1000) {
  const hist = Object.fromEntries(state.managers.map(m => [m.id, []]));
  for (let i = 0; i < REGULAR_GWS; i++) {
    if (gwStatus(i) !== 'final') continue;
    for (const m of state.managers) hist[m.id].push(gwManagerPoints(m.id, i));
  }
  const played = hist[state.managers[0].id].length;
  if (played < 3 || played >= REGULAR_GWS) return null; // too early to guess / nothing left to simulate
  const dist = {};
  for (const m of state.managers) {
    const a = hist[m.id];
    const mean = a.reduce((t, x) => t + x, 0) / a.length;
    const sd = Math.sqrt(a.reduce((t, x) => t + (x - mean) ** 2, 0) / a.length);
    dist[m.id] = { mean, sd: Math.max(6, sd) };
  }
  const base = h2hStandings(false);
  const remaining = [];
  for (let i = 0; i < REGULAR_GWS; i++) if (gwStatus(i) !== 'final') remaining.push(i);
  const counts = Object.fromEntries(state.managers.map(m => [m.id, 0]));
  const norm = ({ mean, sd }) => mean + sd * Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
  for (let r = 0; r < runs; r++) {
    const pts = {}, pf = {};
    for (const row of base) { pts[row.id] = row.pts; pf[row.id] = row.pf; }
    for (const i of remaining) for (const [a, b] of pairingsFor(i)) {
      const sa = norm(dist[a]), sb = norm(dist[b]);
      pf[a] += sa; pf[b] += sb;
      if (Math.abs(sa - sb) < 0.5) { pts[a]++; pts[b]++; } else if (sa > sb) pts[a] += 3; else pts[b] += 3;
    }
    state.managers.map(m => m.id)
      .sort((x, y) => (pts[y] - pts[x]) || (pf[y] - pf[x]))
      .slice(0, 4).forEach(id => counts[id]++);
  }
  return Object.fromEntries(Object.entries(counts).map(([id, c]) => [id, Math.round(100 * c / runs)]));
}
/* ---------------- the trade block ---------------- */
const blockList = mid => toArr(state.tradeBlock?.[mid]);
const onBlock = pid => state.managers.some(m => blockList(m.id).includes(pid));
function toggleBlock(mid, pid) {
  const list = blockList(mid);
  state.tradeBlock = { ...(state.tradeBlock || {}), [mid]: list.includes(pid) ? list.filter(x => x !== pid) : [...list, pid] };
  pushShared('tradeBlock', state.tradeBlock);
  save(); render();
}

/* ---------------- head-to-head ---------------- */
function gwStatus(i) {
  const ev = gwEvent(i);
  const synced = !!ev && Object.keys(ev.playerStats || {}).length > 0;
  if (synced && (ev.final || gwIsOver(i))) return 'final';
  if (synced) return 'live';
  if (gwHasStarted(i)) return 'underway';
  return 'upcoming';
}
function h2hStandings(includeLive = false) {
  const rows = Object.fromEntries(state.managers.map(m => [m.id, { id: m.id, name: m.name, team: m.team, p: 0, w: 0, d: 0, l: 0, pts: 0, pf: 0, pa: 0 }]));
  for (let i = 0; i < REGULAR_GWS; i++) {
    const st = gwStatus(i);
    if (st !== 'final' && !(includeLive && st === 'live')) continue;
    for (const [a, b] of pairingsFor(i)) {
      const pa = gwManagerPoints(a, i), pb = gwManagerPoints(b, i);
      rows[a].p++; rows[b].p++;
      rows[a].pf += pa; rows[a].pa += pb;
      rows[b].pf += pb; rows[b].pa += pa;
      if (pa > pb) { rows[a].w++; rows[a].pts += 3; rows[b].l++; }
      else if (pb > pa) { rows[b].w++; rows[b].pts += 3; rows[a].l++; }
      else { rows[a].d++; rows[b].d++; rows[a].pts++; rows[b].pts++; }
    }
  }
  return Object.values(rows).sort((x, y) => y.pts - x.pts || managerPoints(y.id) - managerPoints(x.id));
}

/* ---------------- FPL sync ---------------- */
// Stats are fetched by a GitHub Action from the official FPL API and committed
// to data/stats.json + data/fixtures.json. The app just reads those files —
// player ids are FPL's own, so there is no name-matching to go wrong.
let liveTimer = null;
function anyMatchLive() { return state.fixtures.some(f => f.started && !f.finished); }

/* ---- the Vidiprinter (ledger #8 — Tussie's Soccer-Saturday ticker) ----
   Every stats sync is diffed against the last; anything that happened
   comes off the tape, newest first. Kept per device, like a real telly. */
const VIDI_KEY = 'tl2627-vidi';
const VIDI_WORDS = { 10: 'TEN', 11: 'ELEVEN', 12: 'TWELVE', 13: 'THIRTEEN', 14: 'FOURTEEN', 15: 'FIFTEEN', 16: 'SIXTEEN' };
let vidiFeed = [];
try { vidiFeed = JSON.parse(localStorage.getItem(VIDI_KEY)) || []; } catch { vidiFeed = []; }
function vidiPush(lines) {
  if (!lines.length) return;
  vidiFeed = [...lines, ...vidiFeed].slice(0, 60);
  try { localStorage.setItem(VIDI_KEY, JSON.stringify(vidiFeed)); } catch { /* tape full, carry on */ }
}
const VIDI_EVENTS = [
  ['g', '⚽', n => n > 1 ? `${n} GOALS` : 'GOAL'],
  ['a', '🅰️', n => n > 1 ? `${n} assists` : 'assist'],
  ['ps', '🧄', () => 'PENALTY SAVED'],
  ['pm', '🙈', () => 'penalty missed'],
  ['og', '😬', () => 'own goal'],
  ['rc', '🟥', () => 'RED CARD'],
  ['yc', '🟨', () => 'booked'],
];
function vidiDiff(gwIdx, oldPS, newPS) {
  if (state.phase !== 'season' || !oldPS || !Object.keys(oldPS).length) return;
  // the ticker credits the fantasy team — starters get the points line
  const starterOf = {}, benchOf = {};
  for (const m of state.managers) {
    for (const pid of effectiveXI(m.id, gwIdx).xi) starterOf[pid] = m.id;
    for (const p of squadAt(m.id, gwIdx)) if (starterOf[p.id] == null) benchOf[p.id] = m.id;
  }
  const lines = [];
  for (const [pid, s] of Object.entries(newPS)) {
    const p = PLAYER_BY_ID[pid];
    if (!p) continue;
    const o = oldPS[pid] || {};
    const bits = [];
    for (const [k, icon, word] of VIDI_EVENTS) {
      const d = (s[k] || 0) - (o[k] || 0);
      if (d > 0) bits.push(`${icon} ${word(d)}`);
    }
    if (!bits.length) continue;
    const dp = statPoints(p, s) - (Object.keys(o).length ? statPoints(p, o) : 0);
    const now = statPoints(p, s);
    const mid = starterOf[p.id];
    const who = mid != null ? `${teamName(mid)} ${dp >= 0 ? '+' : ''}${dp}`
      : benchOf[p.id] != null ? `benched by ${teamName(benchOf[p.id])} (!)` : 'the Trough';
    const haul = now >= 10 && mid != null ? ` (${VIDI_WORDS[now] || now}!!)` : '';
    lines.push({ ts: Date.now(), gw: GAMEWEEKS[gwIdx].n, txt: `${bits.join(' · ')} — ${p.name} (${p.club}) — ${who}${haul}` });
  }
  vidiPush(lines);
}
function vidiCard(compact = false) {
  const live = anyMatchLive();
  if (!vidiFeed.length && !live) return '';
  const rows = vidiFeed.slice(0, compact ? 12 : 30).map(l =>
    `<div class="vidi-line"><span class="vidi-when">${new Date(l.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} GW${l.gw}</span> ${esc(l.txt)}</div>`).join('');
  return `<div class="card" style="margin-top:14px">
    <h2>The Vidiprinter ${live ? '<span class="tag live-tag"><span class="rec"></span>LIVE</span>' : ''} <span class="muted" style="font-weight:400;font-size:12px">every incident, straight off the wire</span></h2>
    <div class="vidi-tape">${rows || '<div class="vidi-line" style="color:var(--muted)">The tape is quiet. Kick-off will fix that.</div>'}</div>
    <p class="muted" style="font-size:10.5px;margin-top:6px">Sponsored by Ceefax page 302. Lines land as the feed refreshes (~15 min on matchdays); the tape lives on this device.</p>
  </div>`;
}

async function syncNow(manual = false) {
  if (demoMode) { if (manual) toast('Demo mode — the results are fictional, like Blanky’s title chances post GW10'); return; }
  const btn = $('#syncBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Tapping…'; }
  try {
    const bust = `?t=${Date.now()}`;
    const [statsRes, fxRes] = await Promise.all([
      fetch(`data/stats.json${bust}`),
      fetch(`data/fixtures.json${bust}`),
    ]);
    const stats = await statsRes.json();
    const fixtures = await fxRes.json();
    state.feedGenerated = stats.generated || null; // for the stale-feed warning
    state.fixtures = fixtures
      .filter(f => f.date)
      .sort((a, b) => a.date.localeCompare(b.date));
    let fresh = 0;
    for (const [gwN, gw] of Object.entries(stats.gws || {})) {
      const i = +gwN - 1;
      if (!GAMEWEEKS[i]) continue;
      const key = `gw${gwN}`;
      const before = JSON.stringify(state.matchStats[key]?.playerStats || {}).length;
      const oldPS = state.matchStats[key]?.playerStats;
      state.matchStats[key] = {
        gw: i,
        label: GAMEWEEKS[i].label,
        date: GAMEWEEKS[i].from,
        final: !!gw.finished,
        playerStats: gw.stats || {},
      };
      if (JSON.stringify(gw.stats || {}).length !== before) fresh++;
      try { vidiDiff(i, oldPS, gw.stats || {}); } catch (e) { console.warn('[vidi]', e); }
    }
    state.lastSync = new Date().toISOString();
    save(); render();
    if (manual) toast(fresh ? `Lines tapped — ${fresh} gameweek${fresh > 1 ? 's' : ''} updated` : 'Lines tapped — nothing new');
  } catch (err) {
    console.error(err);
    if (manual) toast('Sync failed — check connection');
  }
  const b2 = $('#syncBtn');
  if (b2) { b2.disabled = false; b2.textContent = '📞 Tap the lines'; }
  // keep tapping while matches are in play (the Action refreshes every 15 min)
  clearTimeout(liveTimer);
  if (anyMatchLive()) liveTimer = setTimeout(() => syncNow(false), 5 * 60 * 1000);
}

/* ---------------- browser history: back/forward walk the tabs ----------------
   Each view change pushes #view; popstate swaps the view back. Pop-overs
   (player card, matchup) push their own entry so the back button closes
   them instead of leaving the page — the phone-native expectation. */
let hashInit = false;
let ovDepth = 0;        // history entries currently representing open pop-overs
let ovSkipClose = false; // set when a pop-over closed itself and fired history.back()
function syncHash() {
  if (state.phase === 'setup') return;
  const want = `#${state.view}`;
  if (location.hash === want) return;
  try {
    hashInit ? history.pushState(null, '', want) : history.replaceState(null, '', want);
  } catch { /* file:// — no history, no problem */ }
  hashInit = true;
}
function pushOvState() {
  try { history.pushState({ ov: ++ovDepth }, '', location.hash); } catch { ovDepth--; }
}
function closeOv(el) {
  el.remove();
  if (history.state && history.state.ov) {
    ovSkipClose = true;
    try { history.back(); } catch { ovSkipClose = false; }
  }
}
window.addEventListener('popstate', () => {
  if (ovDepth > 0) {
    ovDepth--;
    if (ovSkipClose) { ovSkipClose = false; return; }
    const ovs = document.querySelectorAll('.overlay');
    if (ovs.length) ovs[ovs.length - 1].remove();
    return;
  }
  const v = location.hash.slice(1);
  if (state.phase !== 'setup' && v && v !== state.view && NAV_ITEMS.some(([k]) => k === v)) {
    state.view = v; save(); render();
  }
});

/* ---------------- views ---------------- */
const NAV_ITEMS = [
  ['dash', 'Dashboard'],
  ['draft', 'The Console'],
  ['team', 'My Team'],
  ['transfers', 'Transfers'],
  ['h2h', 'Head-to-Head'],
  ['cup', 'The Monzo Cup'],
  ['table', 'League Table'],
  ['fixtures', 'Fixtures'],
  ['rules', 'Rules'],
  ['settings', 'Settings'],
];

let lastRenderedView = null;
function render() {
  // keep keyboard focus across re-renders (remote updates land mid-typing)
  const ae = document.activeElement;
  const focusId = ae && ae.id && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT') ? ae.id : null;
  let caret = null;
  try { caret = focusId && ae.selectionStart != null ? ae.selectionStart : null; } catch { caret = null; }

  syncHash();
  // fresh page starts at the top; re-renders of the same page hold position
  if (lastRenderedView !== state.view) { window.scrollTo(0, 0); lastRenderedView = state.view; window.onscroll = null; }
  renderNav();
  renderSyncArea();
  let bar = $('#demoBar');
  if (demoMode && !bar) {
    bar = document.createElement('div');
    bar.id = 'demoBar';
    bar.className = 'demo-bar';
    bar.innerHTML = `<span class="rec"></span> DEMO — fake draft, fictional results. Your real league is untouched. <button class="btn small" id="demoExit">Exit demo</button>`;
    document.body.appendChild(bar);
    $('#demoExit').onclick = exitDemo;
  } else if (!demoMode && bar) {
    bar.remove();
  }
  const main = $('#main');
  if (state.phase === 'setup') { main.innerHTML = viewSetup(); bindSetup(); return; }
  switch (state.view) {
    case 'draft': main.innerHTML = viewDraft(); bindDraft(); break;
    case 'team': main.innerHTML = viewTeam(); bindTeam(); break;
    case 'h2h': main.innerHTML = viewH2H(); bindH2H(); break;
    case 'dash': main.innerHTML = viewDash(); bindDash(); break;
    case 'transfers': main.innerHTML = viewTransfers(); bindTransfers(); break;
    case 'cup': main.innerHTML = viewCup(); bindCup(); break;
    case 'table': main.innerHTML = viewTable(); bindTable(); break;
    case 'fixtures': main.innerHTML = viewFixtures(); bindFixtures(); break;
    case 'rules': main.innerHTML = viewRules(); break;
    case 'settings': main.innerHTML = viewSettings(); bindSettings(); break;
    default: state.view = 'draft'; render();
  }
  renderIdentity();
  maybeDrinksBreak();
  broadcastOnPick();
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      try { if (caret != null) el.setSelectionRange(caret, caret); } catch { /* selects */ }
    }
  }
}

async function pinHash(mid, pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`tl2627:${mid}:${pin}`));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
// claim an identity: verify the PIN if one is set, offer to set one if not
async function claimIdentity(mid) {
  if (mid !== -1 && state.pins?.[mid]) {
    const pin = prompt(`PIN for ${managerName(mid)}:`);
    if (pin == null) return false;
    if (await pinHash(mid, pin.trim()) !== state.pins[mid]) { toast('Wrong PIN. The Committee has logged this attempt.'); return false; }
  } else if (mid !== -1 && netOn()) {
    // first sign-in: a PIN is required — it's what stops Tussie acting as you
    const pin = prompt(`First sign-in for ${managerName(mid)} — set a PIN (4+ digits). You'll use it on any device.`);
    if (!pin || pin.trim().length < 4) { toast('A PIN (4+ digits) is required to sign in.'); return false; }
    (state.pins = state.pins || {})[mid] = await pinHash(mid, pin.trim());
    pushShared(`pins/${mid}`, state.pins[mid]);
    save();
    toast('PIN set. Do not tell Tussie.');
  }
  whoami = mid;
  localStorage.setItem(WHO_KEY, whoami);
  render();
  toast(mid === -1 ? 'Spectator mode.' : `Welcome, ${managerName(mid)}. This conversation is being recorded.`);
  return true;
}

let forceIdentity = false; // set when an action needs a signed-in manager first
function renderIdentity() {
  let ov = $('#whoOverlay');
  const needed = (netOn() && state.phase !== 'setup' && !whoami) || forceIdentity;
  if (!needed) { ov?.remove(); return; }
  ov?.remove();
  ov = document.createElement('div');
  ov.id = 'whoOverlay';
  ov.className = 'overlay';
  ov.innerHTML = `<div class="card" style="max-width:560px;width:94%">
    <h2>Sign in</h2>
    <p class="muted" style="font-size:13px;margin-bottom:14px">Pick your team. First sign-in sets your PIN (4+ digits); after that it's your key on any device. Forgotten PINs go to the Chairman.</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px;margin-bottom:10px">
    ${state.managers.map((m, i) => `<button class="btn ghost" data-who="${m.id}" style="text-align:left;padding:10px 12px">
      <b>${esc(m.team || m.name)}</b>${i === 0 ? ' <span class="tag">Chairman</span>' : ''}<br>
      <span class="muted" style="font-size:11.5px">${esc(m.name)} ${state.pins?.[m.id] ? '&#128274;' : '<span style="color:var(--accent)">· first sign-in</span>'}</span>
    </button>`).join('')}
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn ghost small" data-who="-1" style="flex:1;opacity:.75">&#128065; Just watching</button>
      <button class="btn ghost small" id="whoDemo" style="flex:1;opacity:.75">&#127918; Show me a demo season</button>
      ${forceIdentity ? '<button class="btn ghost small" id="whoCancel" style="opacity:.75">&#10005;</button>' : ''}
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#whoDemo').onclick = () => { forceIdentity = false; ov.remove(); enterDemo(); };
  const wc = ov.querySelector('#whoCancel');
  if (wc) wc.onclick = () => { forceIdentity = false; ov.remove(); };
  ov.querySelectorAll('[data-who]').forEach(b => b.onclick = async () => {
    if (await claimIdentity(+b.dataset.who)) { forceIdentity = false; render(); }
  });
}

function renderNav() {
  const nav = $('#nav');
  if (state.phase === 'setup') { nav.innerHTML = ''; return; }
  // attention dots — the app taps you on the shoulder when it needs you
  const dots = {};
  if (state.phase === 'season' && whoami && whoami !== -1) {
    const offers = toArr(state.trades).filter(t => t.status === 'pending' && t.to === whoami).length;
    if (offers) dots.transfers = offers;
    const cur = currentGwIndex();
    if (!gwHasStarted(cur)) {
      const crocked = lineupFor(whoami, cur).filter(pid => 'isnu'.includes(PLAYER_BY_ID[pid]?.status)).length;
      if (crocked) dots.team = crocked;
    }
  }
  nav.innerHTML = NAV_ITEMS.map(([id, label]) =>
    `<button data-view="${id}" class="${state.view === id ? 'active' : ''}">${label}${dots[id] ? `<span class="nav-dot" title="Needs your attention">${dots[id]}</span>` : ''}</button>`).join('');
  nav.querySelectorAll('button').forEach(b => b.onclick = () => { state.view = b.dataset.view; save(); render(); });
  // phones: the nav is a swipeable strip — keep the active tab in view
  if (nav.scrollWidth > nav.clientWidth) nav.querySelector('.active')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function renderSyncArea() {
  const el = $('#syncArea');
  if (!el || state.phase === 'setup') { if (el) el.innerHTML = ''; return; }
  const bits = [];
  if (anyMatchLive()) bits.push('<span class="live-pill"><span class="rec"></span>LIVE</span>');
  // the feed going quiet on a matchday should be visible, not discovered
  if (state.feedGenerated && anyMatchLive()) {
    const ageH = (Date.now() - new Date(state.feedGenerated).getTime()) / 3600000;
    if (ageH > 1.5) bits.push(`<span class="tag" style="background:#4a3a10;color:#ffd98a" title="The stats feed normally refreshes every 15 minutes on matchdays. Scores may be lagging.">&#9888; feed ${ageH < 2 ? '90m' : Math.round(ageH) + 'h'} stale</span>`);
  }
  if (syncOn()) {
    bits.push(`<span class="conn ${syncConnected ? 'up' : ''}" title="${syncConnected ? 'Live sync: connected' : 'Live sync: reconnecting — changes will queue'}">&#9679;</span>`);
    const who = whoami === -1 ? 'Spectating' : (whoami ? esc(managerName(whoami)) : 'Who are you?');
    bits.push(`<button class="tag" id="whoBtn" style="cursor:pointer" title="Switch who this device acts as">${who}</button>`);
  }
  if (state.phase === 'season') {
    const last = state.lastSync ? new Date(state.lastSync).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never';
    bits.push(`<span>Last intercept: ${last}</span><button id="syncBtn" class="btn small">&#128222; Tap the lines</button>`);
  }
  bits.push(`<button class="tag" id="muteBtn" style="cursor:pointer" title="Broadcast sound (Ian's mute button)">${soundOn() ? '&#128266;' : '&#128263;'}</button>`);
  el.innerHTML = bits.join('');
  const mb = $('#muteBtn');
  if (mb) mb.onclick = () => {
    localStorage.setItem('tl2627-mute', soundOn() ? '1' : '0');
    renderSyncArea();
    toast(soundOn() ? 'Broadcast sound on. Sorry, Ian.' : 'Broadcast muted. Ian wins this one.');
  };
  const wb = $('#whoBtn');
  if (wb) wb.onclick = () => { whoami = null; localStorage.removeItem(WHO_KEY); render(); };
  const sb = $('#syncBtn');
  if (sb) sb.onclick = () => syncNow(true);
}

/* ----- setup ----- */
function viewSetup() {
  const m = state.managers;
  const { posMin, posMax } = state.settings;
  return `
  <div class="setup-wrap">
    <div class="setup-hero">
      <h2>&#9917; The League &mdash; 2026/27</h2>
      <p>Twelve managers. One snake draft. Every player in the Premier League.<br>Est. 2015. No phone taps. Allegedly.</p>
    </div>
    <div class="card">
      <h2>Managers</h2>
      ${m.map((mg, i) => `
        <div class="mgr-row">
          <span class="mgr-num">${i + 1}</span>
          <input type="text" maxlength="24" placeholder="Manager ${i + 1} name" data-mgr="${mg.id}" value="${esc(mg.name)}">
          <input type="text" maxlength="28" placeholder="Team name" data-mgrteam="${mg.id}" value="${esc(mg.team || '')}">
          <button class="btn ghost small" data-mgrup="${i}" ${i === 0 ? 'disabled' : ''} title="Move up the draft order">&#9650;</button>
        </div>`).join('')}
      <p class="muted" style="font-size:11.5px;margin-top:8px">First manager listed is the commissioner. Team names pulled from the archive — correct as you see fit.</p>
    </div>
    <div class="card">
      <h2>Squad rules</h2>
      <p class="muted" style="font-size:12px;margin-bottom:10px">Squads of <b>${state.settings.squadSize}</b>, flexible make-up between each position's min and max.</p>
      <div class="quota-grid">
        ${['GK', 'DF', 'MF', 'FW'].map(pos => `
          <div><label>${POS_LABEL[pos]} min–max</label>
          <div style="display:flex;gap:6px">
            <input type="number" min="0" max="11" data-posmin="${pos}" value="${posMin[pos]}">
            <input type="number" min="0" max="11" data-posmax="${pos}" value="${posMax[pos]}">
          </div></div>`).join('')}
      </div>
      <div style="margin-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <label style="font-size:12px;color:var(--muted);font-weight:700">SQUAD SIZE</label>
        <input type="number" min="11" max="20" id="squadSize" value="${state.settings.squadSize}" style="width:60px">
        <label style="font-size:12px;color:var(--muted);font-weight:700;margin-left:10px">PICK TIMER</label>
        <select id="pickTimer">
          ${[0, 20, 30, 45, 60].map(t => `<option value="${t}" ${state.settings.pickTimer === t ? 'selected' : ''}>${t ? t + 's — autopick at zero' : 'Off'}</option>`).join('')}
        </select>
      </div>
      <div class="setup-total" id="setupTotal"></div>
    </div>
    <button class="btn" id="startDraft" style="padding:14px;font-size:16px">Randomise order &amp; start the draft</button>
    <button class="btn ghost" id="startDraftOrdered" style="padding:12px">Start in the order listed above</button>
    <button class="btn ghost" id="demoBtn">Have a look around first — demo a finished season</button>
  </div>`;
}
function bindSetup() {
  const updateTotal = () => {
    const total = state.settings.squadSize;
    $('#setupTotal').innerHTML = `Squad size: <b>${total}</b> each &middot; <b>${total * state.managers.length}</b> of ${PLAYERS.length} players drafted &middot; starting XI picked each gameweek &middot; weekly waivers, bottom feeds first`;
  };
  document.querySelectorAll('[data-mgr]').forEach(inp => inp.oninput = () => {
    state.managers.find(m => m.id === +inp.dataset.mgr).name = inp.value;
  });
  document.querySelectorAll('[data-mgrteam]').forEach(inp => inp.oninput = () => {
    state.managers.find(m => m.id === +inp.dataset.mgrteam).team = inp.value;
  });
  document.querySelectorAll('[data-posmin]').forEach(inp => inp.oninput = () => {
    state.settings.posMin[inp.dataset.posmin] = Math.max(0, +inp.value || 0);
  });
  document.querySelectorAll('[data-posmax]').forEach(inp => inp.oninput = () => {
    state.settings.posMax[inp.dataset.posmax] = Math.max(0, +inp.value || 0);
  });
  $('#squadSize').oninput = e => { state.settings.squadSize = Math.max(11, +e.target.value || 14); updateTotal(); };
  $('#pickTimer').onchange = e => { state.settings.pickTimer = +e.target.value || 0; };
  updateTotal();
  $('#demoBtn').onclick = enterDemo;
  document.querySelectorAll('[data-mgrup]').forEach(b => b.onclick = () => {
    const i = +b.dataset.mgrup;
    [state.managers[i - 1], state.managers[i]] = [state.managers[i], state.managers[i - 1]];
    render();
  });
  const startDraft = randomise => {
    // only the Chairman pulls this trigger — sign in first if the device hasn't
    if (netOn() && whoami !== state.managers[0].id) {
      toast('Only the Chairman starts the draft — sign in as him to prove it');
      forceIdentity = true;
      renderIdentity();
      return;
    }
    if (!confirm('This starts the REAL draft for all twelve managers. Everyone ready?')) return;
    state.managers.forEach((m, i) => { if (!m.name.trim()) m.name = `Manager ${i + 1}`; });
    if (state.settings.squadSize < 11) { toast('Squads need at least 11 for a starting XI'); return; }
    const { posMin, posMax } = state.settings;
    const minSum = posMin.GK + posMin.DF + posMin.MF + posMin.FW;
    const maxSum = posMax.GK + posMax.DF + posMax.MF + posMax.FW;
    if (minSum > state.settings.squadSize || maxSum < state.settings.squadSize) { toast('Position min/max can’t make a legal squad'); return; }
    state.draft.order = randomise
      ? state.managers.map(m => m.id).sort(() => Math.random() - 0.5)
      : state.managers.map(m => m.id);
    if (state.settings.pickTimer) state.draft.deadline = Date.now() + 5 * 60 * 1000;
    // draft-night snapshot: anyone who joins a PL club after this is locked until the window shuts
    state.draftPool = { at: Date.now(), ids: Object.fromEntries(PLAYERS.map(p => [p.id, p.club])) };
    state.phase = 'draft';
    state.view = 'draft';
    publishAll();
    save(); render();
    localStorage.setItem('tl2627-ceremony-seen', state.draft.order.join('-'));
    showCeremony();
  };
  $('#startDraft').onclick = () => startDraft(true);
  $('#startDraftOrdered').onclick = () => startDraft(false);
}

/* ----- opening ceremony (requested by Marc, dedicated to Ian) ----- */
// each club's flag is carried by a selected legend (selection panel: the Committee)
const FLAG_BEARERS = {
  'Arsenal': 'Ian Wright, already crying',
  'Aston Villa': 'Prince William, heir to the throne, season ticket in the Holte End apparently',
  'Bournemouth': 'a man who remembers when this was a fairytale',
  'Brentford': 'a data analyst carrying a spreadsheet printed on a flag',
  'Brighton': 'the ghost of a future £100m midfielder, currently 17',
  'Burnley': 'Sean Dyche, gravel voice audible over the PA',
  'Chelsea': 'Roman Abramovich’s lawyers, waving from a safe distance',
  'Crystal Palace': 'the entire Holmesdale Fanatics drum section',
  'Everton': 'Duncan Ferguson, escorting two burglars he has made friends with',
  'Fulham': 'Hugh Grant, apologising charmingly',
  'Leeds': 'Marcelo Bielsa on an upturned bucket',
  'Liverpool': 'Jürgen Klopp, hugging the flagpole',
  'Man City': 'a KC from Freshfields carrying box 116 of 130',
  'Man Utd': 'Sir Alex Ferguson, pointing at his watch',
  'Newcastle': 'a topless man in December. Feels like the north wind personally',
  "Nott'm Forest": 'Brian Clough’s statue, carried by four men, still smarter than most managers',
  'Sunderland': 'the Netflix documentary crew, filming season nine',
  'Spurs': 'the Premier League trophy, kept a respectful, familiar distance away',
  'West Ham': 'Ray Winstone’s floating head, slightly too big',
  'Wolves': 'a very good sports scientist selling a very good midfielder',
};
function showCeremony() {
  if ($('#ceremony')) return;
  const order = state.draft.order;
  if (!order.length) return;
  const ordinals = ['twelfth', 'eleventh', 'tenth', 'ninth', 'eighth', 'seventh', 'sixth', 'fifth', 'fourth', 'third', 'second', 'FIRST'];
  const steps = [
    { h: '&#9917; THE OPENING CEREMONY', p: 'Live and exclusive coverage with David Prutton, alongside Big Al Brazil, who has been here since the gallops. Season twelve of The League. Ian, be upstanding. Especially you.' },
    { h: '&#127884; THE PARADE OF CLUBS', p: '', parade: true },
    { h: '&#127908; Main stage', p: 'Coldplay perform Viva la Vida in its 9-minute extended ceremony arrangement. Chris Martin has been told this is a twelve-man WhatsApp league that left its old website over £145. He says every revolution is beautiful.' },
    { h: '&#127930; The anthems', p: 'The stadium now rises for a full and unabridged rendition of North London Forever. Marc weeps openly. Ian has been located attempting to leave the venue. Stewards have returned him to his seat.', anthem: true },
    { h: '&#129309; The draw', p: 'The Committee shuffles the envelopes. The order is random. The complaints will not be.' },
    ...[...order].reverse().map((mid, i) => ({
      h: `Drafting ${ordinals[i + (ordinals.length - order.length)]}…`, p: managerName(mid), big: true,
    })),
    { h: 'LET THE DRAFT BEGIN', p: `${managerName(order[0])} is on the clock. The phones are not tapped. Allegedly.` },
  ];
  let i = 0;
  const ov = document.createElement('div');
  ov.id = 'ceremony';
  ov.className = 'overlay';
  ov.innerHTML = '<div id="cerStage" style="display:flex;flex-direction:column;align-items:center;gap:12px;width:92%;max-width:520px"><div id="cerCard" style="width:100%"></div></div>';
  document.body.appendChild(ov);
  let paradeTimer = null;
  const show = () => {
    clearInterval(paradeTimer);
    if (i >= steps.length) { ov.remove(); return; }
    const s = steps[i];
    $('#cerCard').innerHTML = `<div class="card" style="text-align:center">
      <h2 style="margin-bottom:12px">${s.h}</h2>
      ${s.parade ? '<div id="paradeSlot" class="parade-slot"></div>'
        : s.big ? `<div class="ceremony-name">${esc(s.p)}</div>` : `<p class="rules-p" style="text-align:center">${esc(s.p)}</p>`}
      <div style="margin-top:18px;display:flex;gap:8px;justify-content:center">
        <button class="btn small" id="cerNext">${i === steps.length - 1 ? 'To the Console' : 'Continue the pomp'}</button>
        <button class="btn ghost small" id="cerSkip" title="Reserved for Ian">Skip ceremony (Ian's button)</button>
      </div></div>`;
    if (s.parade) {
      playSound('sting');
      let f = 0;
      const nations = TEAMS;
      const showFlag = () => {
        const slot = $('#paradeSlot');
        if (!slot) { clearInterval(paradeTimer); return; }
        if (f >= nations.length) {
          slot.innerHTML = `<p class="rules-p" style="text-align:center">All ${nations.length} clubs present. Ian checked his watch ${nations.length} times.</p>`;
          clearInterval(paradeTimer);
          return;
        }
        const t = nations[f];
        slot.innerHTML = `${flagImg(t.name, true).replace('class="flag big"', 'class="flag parade-flag"')}
          <div class="parade-team">${esc(t.name)}</div>
          <div class="parade-bearer">flag carried by ${esc(FLAG_BEARERS[t.name] || 'a dignitary')}</div>`;
        f++;
      };
      showFlag();
      paradeTimer = setInterval(showFlag, 900);
    }
    // the anthem takes the stage and plays on through the draw and the reveal
    if (s.anthem && !$('#cerPlayer')) {
      const player = document.createElement('div');
      player.id = 'cerPlayer';
      player.style.cssText = 'width:100%;border-radius:12px;overflow:hidden;box-shadow:var(--shadow)';
      player.innerHTML = `<iframe width="100%" height="200" style="display:block;border:0"
        src="https://www.youtube-nocookie.com/embed/wjCJv4W4kvw?autoplay=1&rel=0&playsinline=1"
        title="Louis Dunford — The Angel (North London Forever)"
        allow="autoplay; encrypted-media" allowfullscreen></iframe>
        <div style="background:var(--card2);font-size:11px;color:var(--muted);padding:6px 10px;text-align:center">Louis Dunford &mdash; The Angel (North London Forever). If your phone blocks autoplay, tap play. Ian: volume stays up.</div>`;
      $('#cerStage').appendChild(player);
    }
    $('#cerNext').onclick = () => { i++; show(); };
    $('#cerSkip').onclick = () => { ov.remove(); toast('Ceremony skipped. Ian nods, once.'); };
  };
  show();
}

/* ----- drinks breaks (mandatory, per Marc; non-negotiable, per Ian's objections) ----- */
const DRINKS_COPY = [
  'FIRST DRINKS BREAK — a third of the way. Hydrate. The Committee is having a Negroni and reviewing your picks with interest.',
  'SECOND DRINKS BREAK — two thirds done. Stretch the legs. Ian: this break is contractually mandatory and was added specifically because of you.',
];
function drinksBreakAt(n) {
  const t = totalPicks();
  if (n === Math.round(t / 3)) return DRINKS_COPY[0];
  if (n === Math.round(2 * t / 3)) return DRINKS_COPY[1];
  return null;
}
function maybeDrinksBreak() {
  const ov = $('#drinksBreak');
  const n = pickNo();
  const due = state.phase === 'draft' && drinksBreakAt(n) && !(state.draft.breaksDone || []).includes(n);
  if (!due) { ov?.remove(); return; }
  if (ov) return;
  const el = document.createElement('div');
  el.id = 'drinksBreak';
  el.className = 'overlay';
  el.innerHTML = `<div class="card" style="max-width:480px;width:92%;text-align:center">
    <div style="font-size:46px;margin-bottom:8px">&#127866;</div>
    <h2>${drinksBreakAt(n)}</h2>
    <button class="btn" id="breakDone" style="margin-top:16px">Back to the Console</button></div>`;
  document.body.appendChild(el);
  $('#breakDone').onclick = () => {
    // deadline first, then the break flag — same-client writes are ordered, so no
    // device ever sees the break end while an expired clock is still in force
    if (state.settings.pickTimer) {
      state.draft.deadline = Date.now() + state.settings.pickTimer * 1000;
      pushShared('draft/deadline', state.draft.deadline);
    }
    state.draft.breaksDone = [...(state.draft.breaksDone || []), n];
    pushShared('draft/breaksDone', state.draft.breaksDone);
    save(); render();
  };
}

/* ----- the punditry desk ----- */
const PUNDITS = {
  prutton: { name: 'David Prutton', emoji: '&#127897;&#65039;', init: 'DP', cls: 'pa-dp' },
  al: { name: 'Big Al Brazil', emoji: '&#127866;', init: 'AB', cls: 'pa-al' },
  redknapp: { name: 'Jamie Redknapp', emoji: '&#128084;', init: 'JR', cls: 'pa-jr' },
  coisty: { name: 'Ally McCoisty', emoji: '&#128516;', init: 'AM', cls: 'pa-am' },
};
// certified lobus registry: big centre-forwards, great feet for big men
const LOBUS_LIST = ['haaland', 'sorloth', 'strand larsen', 'gyokeres', 'lukaku', 'batshuayi',
  'fullkrug', 'weghorst', 'brobbey', 'en nesyri', 'azmoun', 'petkovic', 'budimir',
  'arnautovic', 'embolo', 'nunez', 'dykes', 'giroud', 'kane', 'mateta', 'guirassy', 'igor thiago', 'ali daei'];

function pundComment(pk) {
  const p = PLAYER_BY_ID[pk.playerId];
  const mgr = managerName(pk.managerId);
  const seed = (pk.n * 2654435761 + pk.playerId * 97) >>> 0;
  const pick = arr => arr[seed % arr.length];
  const r = rating(p);
  const rank = ratingRank(r);
  const sameClub = managerSquad(pk.managerId).filter(x => x.team === p.team).length;
  const nm = normName(p.name), mgrN = normName(mgr);
  // bespoke triggers — requested by the panel, vetted by nobody
  if (nm.includes('haaland')) {
    return { who: 'prutton', line: mgrN.includes('ben levy')
      ? `Ben Levy takes Haaland. AGAIN. Third year running he's going to fuck it up with the best striker on Earth. It's genuinely a skill.`
      : `${mgr} drafts Haaland — brave, considering what that player did to Ben Levy's last two seasons. Cursed goods, for me. 2-1.`, sound: 'cheer' };
  }
  if (LOBUS_LIST.some(l => nm.includes(l)) && p.pos === 'FW') {
    return { who: 'al', line: `LOBUS KLAXON — sponsored by Ali Daei, Iranian legend, 108 international goals, the original lobus. Congrats ${mgr}, enjoy your shiny new lobus: ${p.name}. Big unit. Great feet for a big man.`, sound: 'cheer' };
  }
  if (p.team === 'Man City') {
    return { who: 'redknapp', line: mgrN.includes('tussie')
      ? `Tussie takes a City player. "I'll be drafting the entire City team by GW30 regardless" — his words, on the record, in the group chat. ${sameClub + 1} down, ${Math.max(0, 10 - sameClub)} to go.`
      : `${p.name} of Manchester City. ${mgr}'s legal team are across the 115 charges as we speak.` };
  }
  if (p.team === 'Everton' && mgrN.includes('polak')) {
    return { who: 'coisty', line: `Ben Polak drafts an Everton player! With his HEART! Magnificent! Sentimental! Almost certainly points-negative!`, sound: 'cheer' };
  }
  if (p.team === 'Arsenal' && mgrN.includes('conway')) {
    return { who: 'prutton', line: `Marc takes an Arsenal man. Somewhere in the distance, North London Forever starts up. Nobody requested it. Nobody ever has to.` };
  }
  if ((p.status === 'i' || p.status === 's' || p.status === 'u') && pk.n <= state.managers.length * 8) {
    return { who: 'al', line: `${mgr}, small thing — ${p.name} is ${p.status === 's' ? 'SUSPENDED' : 'INJURED'}. Says so right there on the board. ${p.news ? `"${p.news}."` : ''} I need a Guinness.`, sound: 'trombone' };
  }
  if (p.pos === 'GK' && pk.n <= state.managers.length * 2) {
    return { who: 'al', line: `A goalkeeper?! At pick ${pk.n}?! Honestly. I need a coffee. And by coffee I obviously mean a Guinness.`, sound: 'trombone' };
  }
  if (sameClub >= 3) {
    return { who: 'prutton', line: `That's ${sameClub} from ${p.team} for ${mgr}. Like a loan-heavy January window at Barnsley, that. I'm predicting 2-1, by the way. I always am.` };
  }
  if (rank < 25) {
    return { who: pick(['redknapp', 'al', 'coisty']), line: pick([
      `${p.name} is literally a Rolls Royce of a footballer. Literally. Top, top, TOP pick from ${mgr}.`,
      `Top, top player. I had a word with his agent at Cheltenham — lovely fella, bought me a magnum of red. ${mgr}'s done well there.`,
      `Oh I LOVE him! ${p.name}! Absolutely magnificent! What a pick, what a draft, what a MORNING!`,
    ]), sound: 'cheer' };
  }
  if (rank > 400 && pk.n <= state.managers.length * 6) {
    return { who: pick(['al', 'prutton', 'coisty']), line: pick([
      `${p.name}? Never heard of him. And I've heard of EVERYONE. Give it a wide berth, ${mgr}.`,
      `${p.name} at pick ${pk.n}. Shades of a wet Tuesday night at Rotherham about that one.`,
      `${p.name}! ${r} points last season! ${mgr}, you wee rascal, what are you DOING?!`,
    ]), sound: 'trombone' };
  }
  return { who: pick(['prutton', 'al', 'redknapp', 'coisty']), line: pick([
    `Tidy pick from ${mgr}. Honest. Hard-working. EFL-core. 2-1.`,
    `${mgr} goes ${p.name}. Decent shout. Reminds me of a lad I roomed with at Ipswich. Different story for after the break.`,
    `When ${p.name}'s on it, he's literally unplayable. Literally cannot be played. ${mgr} knows it.`,
    `${p.name}, eh? We had him on the show once. Lovely fella. Ate all the biscuits.`,
    `${p.name} of ${p.team}! Honest pro. Good feet. GREAT feet. Right — racing from Chepstow at ten.`,
    `${p.name} at pick ${pk.n}. The Trough nods approvingly. Sticking with 2-1.`,
  ]) };
}
const CLUB_FACTS = {
 "Arsenal": "Once went a whole season unbeaten. Mentions it roughly once per whole season.",
 "Aston Villa": "One of the twelve founders of the Football League — the meeting was a Villa director's idea. They invented this, technically.",
 "Bournemouth": "The stadium holds about 11,000 people. There are secondary schools with more pupils.",
 "Brentford": "Famously had a pub on all four corners of their old ground. The new ground has a Wetherspoons-shaped hole in its heart.",
 "Brighton": "Nearly dropped out of the Football League in 1997. Now sells midfielders for £100m and it's considered a business model.",
 "Burnley": "Town of about 75,000 — among the smallest ever to win the top flight. Twice.",
 "Chelsea": "Signed so many players they ran out of squad numbers and loaned an entire second squad to Europe. Amortisation is a lifestyle.",
 "Crystal Palace": "The original Crystal Palace burned down in 1936. The football has occasionally matched it.",
 "Everton": "Spent more seasons in the top flight than anyone. Ben would like this noted formally in the minutes.",
 "Fulham": "Craven Cottage has an actual cottage in the corner. It's listed. The football is not.",
 "Leeds": "Under Bielsa, players were weighed daily and murderball was legal. Some of them are still running.",
 "Liverpool": "The anthem is from a 1945 musical. The bench mob knows all the words.",
 "Man City": "The 115 charges have their own Wikipedia page, several podcasts, and a defence bill bigger than most squads. The Committee declines to comment.",
 "Man Utd": "The scoreboard clock at Old Trafford has been showing 'time since last title' in the away end's heads for years.",
 "Newcastle": "Alan Shearer scored 206 goals for them and won nothing. The city named a stand, a statue and several children after him anyway.",
 "Nott'm Forest": "Won back-to-back European Cups with a manager who called himself 'in the top one'. Correctly.",
 "Sunderland": "'Til I Die has more Netflix seasons than they have recent top-half finishes. Both numbers are climbing.",
 "Spurs": "Invented the phrase 'it's the hope that kills you' in spirit, if not in law.",
 "West Ham": "Claim to have won the 1966 World Cup. Three players and a captain — the maths is theirs.",
 "Wolves": "In the 1950s they were unofficial champions of the world under floodlights. The Black Country remembers.",
};

function punditAva(pd) { return `<span class="pundit-ava ${pd.cls}" title="${pd.name}">${pd.init}</span>`; }
function punditryDesk() {
  const recent = [...state.draft.picks].slice(-3).reverse();
  const lines = recent.length ? recent.map(pk => {
    const c = pundComment(pk);
    const pd = PUNDITS[c.who];
    const fact = CLUB_FACTS[PLAYER_BY_ID[pk.playerId].team];
    return `<div class="pundit-line">${punditAva(pd)}<div><b>${pd.name}</b><p>${esc(c.line)}</p>${fact ? `<p class="country-fact">&#127757; ${esc(PLAYER_BY_ID[pk.playerId].team)}: ${esc(fact)}</p>` : ''}</div></div>`;
  }).join('') : `<div class="pundit-line">${punditAva(PUNDITS.prutton)}<div><b>${PUNDITS.prutton.name}</b><p>Welcome to draft night, live and exclusive. Alongside me: Big Al, who's been here since the gallops; Jamie, who has literally never been more excited; and Ally, who loves all ${PLAYERS.length} players equally. Twelve managers, one title, and somewhere out there, a Lobus. I'm predicting 2-1.</p></div></div>`;
  return `<div class="card">
    <h2>The Punditry Desk <span class="tag">LIVE on Sky Sports The Console</span></h2>
    <div class="pundit-strip">${Object.values(PUNDITS).map(pd => `<span class="pundit-chip">${punditAva(pd)}${pd.name} ${pd.emoji}</span>`).join('')}</div>
    ${lines}
  </div>`;
}

/* ----- broadcast audio (synthesized, no files, Ian-mutable) ----- */
let audioCtx = null;
const soundOn = () => localStorage.getItem('tl2627-mute') !== '1';
function actx() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
document.addEventListener('click', () => { try { actx(); } catch { /* no audio */ } }, { once: true });
function tone(c, freq, at, dur, { type = 'triangle', gain = 0.07, slideTo = null } = {}) {
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, c.currentTime + at);
  if (slideTo) o.frequency.linearRampToValueAtTime(slideTo, c.currentTime + at + dur);
  g.gain.setValueAtTime(0, c.currentTime + at);
  g.gain.linearRampToValueAtTime(gain, c.currentTime + at + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + at + dur);
  o.connect(g).connect(c.destination);
  o.start(c.currentTime + at);
  o.stop(c.currentTime + at + dur + 0.05);
}
function playSound(kind) {
  if (!soundOn()) return;
  try {
    const c = actx();
    if (kind === 'cheer') {
      // crowd roar: filtered noise swell + triumphant notes
      const len = c.sampleRate * 1.4;
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.min(i / (len * 0.3), 1 - i / len);
      const src = c.createBufferSource(); src.buffer = buf;
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 0.6;
      const g = c.createGain(); g.gain.value = 0.12;
      src.connect(f).connect(g).connect(c.destination); src.start();
      tone(c, 523, 0.1, 0.15); tone(c, 659, 0.25, 0.15); tone(c, 784, 0.4, 0.4, { gain: 0.09 });
    } else if (kind === 'trombone') {
      // the universal sound of a bad decision
      tone(c, 466, 0, 0.25, { type: 'sawtooth', gain: 0.06, slideTo: 440 });
      tone(c, 415, 0.28, 0.25, { type: 'sawtooth', gain: 0.06, slideTo: 392 });
      tone(c, 370, 0.56, 0.25, { type: 'sawtooth', gain: 0.06, slideTo: 349 });
      tone(c, 330, 0.84, 0.7, { type: 'sawtooth', gain: 0.07, slideTo: 233 });
    } else {
      // broadcast sting
      tone(c, 523, 0, 0.09); tone(c, 659, 0.1, 0.09); tone(c, 784, 0.2, 0.16);
    }
  } catch { /* no audio available */ }
}
let seenPicks = null;
function broadcastOnPick() {
  const n = state.draft.picks.length;
  if (seenPicks === null) { seenPicks = n; return; }
  if (state.phase === 'draft' && n > seenPicks) {
    const c = pundComment(state.draft.picks[n - 1]);
    playSound(c.sound || 'sting');
  }
  seenPicks = n;
}

/* ----- the console (draft) ----- */
let poolFilter = { q: '', team: '', pos: '', sort: 'pts', limit: 60 };

function viewDraft() {
  if (state.phase === 'season') return viewDraftRecap();
  const mid = currentManagerId();
  const n = pickNo();
  const round = Math.floor(n / state.managers.length) + 1;
  const taken = draftedIds();
  const teamsOpts = [...TEAMS].sort((a, b) => a.name.localeCompare(b.name)).map(t => `<option value="${esc(t.name)}" ${poolFilter.team === t.name ? 'selected' : ''}>${esc(t.name)}</option>`).join('');

  return `
  <div class="on-clock">
    <div>
      <div class="who">${esc(managerName(mid))} — you're on the clock</div>
      <div class="pick-meta">Pick ${n + 1} of ${totalPicks()} &middot; Round ${round} of ${state.settings.squadSize}${(() => {
        // every round has a title sponsor (ledger #5) — the hydration break was never in danger
        const sp = typeof AD_BOARDS !== 'undefined' && AD_BOARDS.length ? AD_BOARDS[(round - 1) % AD_BOARDS.length] : null;
        return sp ? ` &middot; Round ${round} brought to you by <b style="color:${sp.c}">${esc(sp.t)}</b> <span class="muted">— ${esc(sp.s)}</span>` : '';
      })()}</div>
      <div class="intercept"><span class="rec"></span>LIVE INTERCEPT &mdash; &ldquo;${esc(interceptFor(n, managerName(mid)))}&rdquo;</div>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      ${state.settings.pickTimer ? '<span class="pick-clock" id="pickClock">–:––</span>' : ''}
      ${state.settings.pickTimer ? `<button class="btn ghost small" id="timewasteBtn" title="Take it to the corner flag (+60s)">&#8987; Timewaste (${2 - (state.draft.timewastes?.[mid] || 0)} left)</button>` : ''}
      <button class="btn ghost small" id="undoPick" ${n === 0 ? 'disabled' : ''}>Undo last</button>
      ${(!netOn() || isCommissioner()) && state.settings.pickTimer ? `<button class="btn ghost small" id="pauseDraft">${state.draft.paused ? '&#9654; Resume' : '&#9208; Pause'}</button>` : ''}
      <button class="btn ghost small" id="autoPick" title="Your autopick list first, then best available. Only the manager on the clock (or the Chairman) can press it.">&#129302; Autopick</button>
    </div>
  </div>
  <div class="clock-strip" id="clockStrip" style="display:none">
    <span class="rec"></span> <b>${esc(managerName(mid))}</b> on the clock
    ${state.settings.pickTimer ? '<span class="pick-clock" id="pickClock2">–:––</span>' : ''}
    <span class="muted">Pick ${n + 1}/${totalPicks()}</span>
  </div>
  <div class="order-strip">${draftOrderStrip()}</div>
  <div class="draft-layout">
    <div class="card">
      <div class="pool-controls">
        <input type="text" id="poolQ" placeholder="Search ${PLAYERS.length - taken.size} available players…" value="${esc(poolFilter.q)}">
        <select id="poolTeam"><option value="">All clubs</option>${teamsOpts}</select>
        <select id="poolPos">
          <option value="">All positions</option>
          ${['GK', 'DF', 'MF', 'FW'].map(p => `<option ${poolFilter.pos === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
      </div>
      ${poolTable()}
    </div>
    <div class="draft-side">
      ${whoami && whoami !== -1 ? `<div class="card">
        <h2>My autopick list <span class="tag">${toArr(state.autolists?.[whoami]).length}</span></h2>
        <p class="muted" style="font-size:11.5px;margin-bottom:8px">Your ranked shortlist. If your clock hits zero, the top available pick goes in. Star players in the pool to add them.</p>
        ${toArr(state.autolists?.[whoami]).map((pid, k) => {
          const p = PLAYER_BY_ID[pid];
          const gone = draftedIds().has(pid);
          return p ? `<div class="lrow" style="font-size:12.5px${gone ? ';opacity:.45;text-decoration:line-through' : ''}">
            <span class="muted">#${k + 1}</span> <span class="pos-badge pos-${p.pos}">${p.pos}</span> ${pname(p)}
            <span style="margin-left:auto;display:flex;gap:4px">
              ${k > 0 ? `<button class="btn ghost small" data-autoup="${k}">&#9650;</button>` : ''}
              <button class="btn ghost small" data-autodel="${k}">&#10005;</button>
            </span></div>` : '';
        }).join('') || '<span class="muted" style="font-size:12px">Empty. Brave.</span>'}
      </div>` : ''}
      <div class="card side-squad">
        <h2>${esc(managerName(mid))}'s squad</h2>
        <div class="quota-bar">${quotaPills(mid)}</div>
        ${managerSquad(mid).sort((a, b) => POS_ORDER[a.pos] - POS_ORDER[b.pos]).map(p => `
          <div class="srow"><span class="pos-badge pos-${p.pos}">${p.pos}</span>${kitImg(p.team, p.pos === 'GK', p)}${pname(p)}</div>
        `).join('') || '<span class="muted">No picks yet</span>'}
      </div>
      ${punditryDesk()}
      <div class="card">
        <h2>Pick history</h2>
        <div class="pick-log">
          ${[...state.draft.picks].reverse().slice(0, 40).map(pk => {
            const p = PLAYER_BY_ID[pk.playerId];
            return `<div class="lrow"><span class="muted">#${pk.n}</span><b>${esc(managerName(pk.managerId))}</b> ${flagImg(p.team)} ${pname(p)}</div>`;
          }).join('') || '<span class="muted">First pick incoming…</span>'}
        </div>
      </div>
    </div>
  </div>`;
}

function draftOrderStrip() {
  const m = state.managers.length;
  const n = pickNo();
  const round = Math.floor(n / m);
  const order = state.draft.order;
  const seq = (round % 2 === 0) ? order : [...order].reverse();
  return seq.map((mid, i) => {
    const globalIdx = round * m + i;
    const cls = globalIdx < n ? 'done' : (globalIdx === n ? 'now' : '');
    return `<span class="order-chip ${cls}">${esc(managerName(mid))}</span>`;
  }).join('<span class="muted" style="align-self:center">›</span>') +
    `<span class="tag" style="margin-left:10px">Round ${round + 1}${round % 2 ? ' (reversed)' : ''}</span>`;
}

function quotaPills(mid) {
  const { posMin, posMax } = state.settings, c = posCount(mid);
  return ['GK', 'DF', 'MF', 'FW'].map(p =>
    `<span class="quota-pill ${c[p] >= posMax[p] ? 'full' : ''}" title="min ${posMin[p]}, max ${posMax[p]}">${p} ${c[p]}/${posMax[p]}</span>`).join('');
}

/* ---- season-aware player metrics (Console pool + the Trough) ----
   Once gameweeks have synced stats, every number is THIS league's scoring,
   computed from matchStats. Until then, fall back to FPL's aggregates. */
const seasonHasStats = () => Object.values(state.matchStats || {}).some(ev => Object.keys(ev.playerStats || {}).length > 0);
let _metricsCache = new Map(), _metricsKey = '';
function metricsFor(p) {
  const live = seasonHasStats();
  const key = live ? 'live:' + Object.values(state.matchStats).reduce((t, ev) => t + Object.keys(ev.playerStats || {}).length, 0) : 'pre';
  if (_metricsKey !== key) { _metricsCache = new Map(); _metricsKey = key; }
  let m = _metricsCache.get(p.id);
  if (m) return m;
  if (live) {
    const { pts, agg } = playerPoints(p.id);
    const evs = Object.values(state.matchStats).filter(ev => ev.playerStats).sort((a, b) => a.gw - b.gw);
    let min = 0;
    for (const ev of evs) min += ev.playerStats[p.id]?.min || 0;
    const last5 = evs.slice(-5);
    const f5 = last5.length ? last5.reduce((t, ev) => t + (ev.playerStats[p.id] ? statPoints(p, ev.playerStats[p.id]) : 0), 0) / last5.length : 0;
    m = { pts, apps: agg.app, min, f5, gw: gwPlayerPoints(p.id, currentGwIndex()), g: agg.g, a: agg.a, cs: agg.cs, ppg: agg.app ? pts / agg.app : 0, xgi: (p.xg || 0) + (p.xa || 0), price: p.price };
  } else {
    // pre-season: FPL's own aggregates until the July wipe, the archive after
    const ls = FPL_WIPED ? lastSeasonOf(p) : null;
    m = ls
      ? { pts: ls.pts, apps: Math.round((ls.mp || 0) / 90), min: ls.mp || 0, f5: 0, gw: 0, g: ls.g || 0, a: ls.a || 0, cs: ls.cs || 0, ppg: ls.ppg || 0, xgi: ls.xgi || 0, price: p.price }
      : { pts: rating(p), apps: Math.round((p.mp || 0) / 90), min: p.mp || 0, f5: 0, gw: 0, g: p.g || 0, a: p.a || 0, cs: p.cs || 0, ppg: p.ppg || 0, xgi: (p.xg || 0) + (p.xa || 0), price: p.price };
  }
  _metricsCache.set(p.id, m);
  return m;
}
// next fixture chip, Draft-Fantasy "Vs" style — comes alive once 26/27 fixtures land
const TEAM_SHORT_BY_NAME = Object.fromEntries(TEAMS.map(t => [t.name, t.short]));
let _fxCache = new Map(), _fxKey = '';
function nextFx(team) {
  const key = String((state.fixtures || []).length);
  if (_fxKey !== key) { _fxCache = new Map(); _fxKey = key; }
  if (_fxCache.has(team)) return _fxCache.get(team);
  const f = (state.fixtures || []).find(x => !x.finished && (x.home === team || x.away === team));
  const v = f ? (f.home === team ? `${TEAM_SHORT_BY_NAME[f.away] || f.away} (H)` : `${TEAM_SHORT_BY_NAME[f.home] || f.home} (A)`) : '—';
  _fxCache.set(team, v);
  return v;
}
// the full column menu, Draft Fantasy style; users pick their own set (kept per device)
const ALL_STAT_COLS = live => [
  { k: 'vs', h: 'Vs', t: 'Next fixture (H/A) — coloured by how scary they are', v: (m, p) => { const t = nextFx(p.team); const opp = t.endsWith('(H)') || t.endsWith('(A)') ? Object.keys(TEAM_BY_NAME).find(n => TEAM_BY_NAME[n].short === t.slice(0, -4).trim()) : null; return opp ? `<span class="${fdrCls(opp)}">${t}</span>` : t; }, cls: ' muted', sortable: false },
  { k: 'price', h: '£m', t: 'Current FPL price', v: m => m.price.toFixed(1) },
  { k: 'apps', h: live ? 'Apps' : '90s', t: live ? 'Appearances' : 'Minutes ÷ 90, last season', v: m => m.apps },
  { k: 'min', h: 'MP', t: 'Minutes played', v: m => m.min },
  { k: 'g', h: 'G', t: 'Goals', v: m => m.g },
  { k: 'a', h: 'A', t: 'Assists', v: m => m.a },
  { k: 'cs', h: 'CS', t: 'Clean sheets', v: m => m.cs },
  { k: 'xgi', h: 'xGI', t: 'Expected goals + assists', v: m => m.xgi.toFixed(1), cls: ' muted' },
  { k: 'f5', h: 'F5', t: 'Form — average points over the last five gameweeks (league scoring)', v: m => m.f5.toFixed(1) },
  { k: 'gw', h: 'GW', t: 'Points this gameweek', v: m => m.gw },
  { k: 'ppg', h: 'PPG', t: live ? 'League points per appearance' : 'FPL points per game, last season', v: m => m.ppg.toFixed(1) },
  { k: 'pts', h: 'Pts', t: live ? 'Points under league scoring' : 'Total FPL points, last season', v: m => m.pts, cls: ' gold' },
];
const DEFAULT_COL_KEYS = live => live
  ? ['vs', 'price', 'apps', 'g', 'a', 'cs', 'xgi', 'f5', 'gw', 'ppg', 'pts']
  : ['vs', 'price', 'apps', 'g', 'a', 'cs', 'xgi', 'ppg', 'pts'];
let _colPrefs;
function visibleColKeys(live) {
  if (_colPrefs === undefined) { try { _colPrefs = JSON.parse(localStorage.getItem('tl2627-cols')); } catch { _colPrefs = null; } }
  return _colPrefs || DEFAULT_COL_KEYS(live);
}
const STAT_COLS = live => ALL_STAT_COLS(live).filter(c => visibleColKeys(live).includes(c.k));
window._colsOpen = false;
function colToggleHtml(live) {
  const vis = visibleColKeys(live);
  return `<details class="col-toggle" style="position:relative;margin-left:auto" ${window._colsOpen ? 'open' : ''}>
    <summary class="btn ghost small" style="list-style:none;display:inline-block">Columns &#9881;</summary>
    <div style="position:absolute;right:0;z-index:6;background:#131c31;border:1px solid var(--line);border-radius:10px;padding:10px;display:grid;gap:5px;min-width:230px;box-shadow:0 8px 24px rgba(0,0,0,.5)">
      ${ALL_STAT_COLS(live).map(c => `<label style="font-size:12px;display:flex;gap:7px;align-items:center;cursor:pointer"><input type="checkbox" data-coltoggle="${c.k}" ${vis.includes(c.k) ? 'checked' : ''}> <b style="min-width:30px">${c.h}</b> <span class="muted">${esc(c.t)}</span></label>`).join('')}
    </div>
  </details>`;
}
function bindColToggle(rerender) {
  document.querySelectorAll('.col-toggle').forEach(d => d.ontoggle = () => { window._colsOpen = d.open; });
  document.querySelectorAll('[data-coltoggle]').forEach(cb => cb.onchange = () => {
    const live = seasonHasStats();
    const set = new Set(visibleColKeys(live));
    cb.checked ? set.add(cb.dataset.coltoggle) : set.delete(cb.dataset.coltoggle);
    _colPrefs = ALL_STAT_COLS(live).map(c => c.k).filter(k => set.has(k)); // keep column order
    localStorage.setItem('tl2627-cols', JSON.stringify(_colPrefs));
    rerender();
  });
}
const metricSort = s => (a, b) => s === 'name' ? a.name.localeCompare(b.name)
  : ((metricsFor(b)[s] ?? 0) - (metricsFor(a)[s] ?? 0)) || rating(b) - rating(a);

function poolTable() {
  const taken = draftedIds();
  const mid = currentManagerId();
  let rows = PLAYERS.filter(p => !taken.has(p.id));
  if (poolFilter.q) {
    const q = normName(poolFilter.q);
    rows = rows.filter(p => normName(p.name).includes(q) || normName(p.team).includes(q) || normName(p.club).includes(q));
  }
  if (poolFilter.team) rows = rows.filter(p => p.team === poolFilter.team);
  if (poolFilter.pos) rows = rows.filter(p => p.pos === poolFilter.pos);
  const s = poolFilter.sort;
  const cols = STAT_COLS(seasonHasStats());
  rows.sort(metricSort(s));
  const total = rows.length;
  rows = rows.slice(0, poolFilter.limit);
  return `
  <div class="pool-wrap">
  <div style="display:flex;align-items:center;margin-bottom:4px">${colToggleHtml(seasonHasStats())}</div>
  <div style="overflow-x:auto">
  <table class="pool-table">
    <thead><tr>
      <th data-sort="name">Player</th><th>Club</th><th>Pos</th>
      <th></th>
      ${cols.map(c => c.sortable === false ? `<th class="num" title="${esc(c.t)}">${c.h}</th>` : `<th class="num" data-sort="${c.k}" title="${esc(c.t)}">${c.h} ${s === c.k ? '▾' : ''}</th>`).join('')}<th></th>
    </tr></thead>
    <tbody>
      ${rows.map(p => `
      <tr class="${statusClass(p)}">
        <td><div class="pcell">${photoImg(p)}<div><div class="pname">${esc(p.name)}</div><div class="pclub">${esc(p.full)}</div></div></div></td>
        <td class="muted" style="white-space:nowrap">${flagImg(p.team)} ${esc(p.club)}</td>
        <td><span class="pos-badge pos-${p.pos}">${p.pos}</span></td>
        <td>${statusChip(p)}</td>
        ${cols.map(c => `<td class="num${c.cls || ''}">${c.v(metricsFor(p), p)}</td>`).join('')}
        <td style="white-space:nowrap"><button class="btn small" data-pick="${p.id}" ${canPick(mid, p) && canActFor(mid) ? '' : `disabled title="${canActFor(mid) ? 'Position limits hit' : `${esc(managerName(mid))} is on the clock, not you`}"`}>Draft</button>${whoami && whoami !== -1 ? `<button class="btn ghost small" data-auto="${p.id}" title="Add to my autopick list">&#9734;</button>` : ''}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  </div>
  ${total > poolFilter.limit ? `<div class="show-more"><button class="btn ghost small" id="showMore">Show more (${total - poolFilter.limit} hidden)</button></div>` : ''}
  </div>`;
}

let clockTimer = null;
let firedDeadline = 0;
function bindDraft() {
  clearInterval(clockTimer);
  if (state.phase === 'season') return;
  // pin a slim clock to the top once the big board scrolls out of sight
  const oc = document.querySelector('.on-clock'), cs = $('#clockStrip');
  if (oc && cs) {
    const onScroll = () => { cs.style.display = oc.getBoundingClientRect().bottom < 0 ? 'flex' : 'none'; };
    window.onscroll = onScroll;
    onScroll();
  }
  if (state.settings.pickTimer) {
    const mid = currentManagerId();
    const tw = $('#timewasteBtn');
    if (tw) {
      const used = state.draft.timewastes?.[mid] || 0;
      tw.disabled = used >= 2 || !canActFor(mid);
      tw.onclick = () => {
        if ((state.draft.timewastes?.[mid] || 0) >= 2) { toast('No timewastes left — play on'); return; }
        (state.draft.timewastes = state.draft.timewastes || {})[mid] = (state.draft.timewastes[mid] || 0) + 1;
        state.draft.deadline = (state.draft.deadline || Date.now()) + 60 * 1000;
        pushShared('draft/timewastes', state.draft.timewastes);
        pushShared('draft/deadline', state.draft.deadline);
        save(); render();
        toast(`${managerName(mid)} is timewasting. Taking it to the corner flag.`);
      };
    }
    clockTimer = setInterval(() => {
      const el = $('#pickClock');
      const el2 = $('#pickClock2'); // the pinned strip's mirror
      if (!el || state.phase !== 'draft') { clearInterval(clockTimer); return; }
      const bn = pickNo();
      const breakDue = drinksBreakAt(bn) && !(state.draft.breaksDone || []).includes(bn);
      if (state.draft.paused) { el.textContent = 'PAUSED'; el.classList.remove('urgent'); if (el2) el2.textContent = 'PAUSED'; return; }
      if (breakDue || $('#drinksBreak') || $('#ceremony')) return; // clock politely waits for pomp
      const left = Math.max(0, Math.round(((state.draft.deadline || 0) - Date.now()) / 1000));
      el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      el.classList.toggle('urgent', left <= 10);
      if (el2) { el2.textContent = el.textContent; el2.classList.toggle('urgent', left <= 10); }
      if (left <= 0 && !state.draft.paused && state.draft.deadline && firedDeadline !== state.draft.deadline) {
        // twelve open consoles must not all fire the deadline pick — when the
        // league is live, only the commissioner's device makes the call
        if (netOn() && !isCommissioner()) return;
        firedDeadline = state.draft.deadline;
        toast('Time! Autopick makes the call.');
        autoPick(true);
      }
    }, 400);
  }
  const pb = $('#pauseDraft');
  if (pb) pb.onclick = () => {
    if (netOn() && !isCommissioner()) { toast('Only the commissioner pauses the draft'); return; }
    if (state.draft.paused) {
      state.draft.paused = false;
      if (state.settings.pickTimer) state.draft.deadline = Date.now() + (state.draft.pausedLeft || state.settings.pickTimer * 1000);
      pushShared('draft/paused', false);
      pushShared('draft/deadline', state.draft.deadline);
      toast('Draft resumed. The clock is live.');
    } else {
      state.draft.paused = true;
      state.draft.pausedLeft = Math.max(5000, (state.draft.deadline || Date.now()) - Date.now());
      pushShared('draft/paused', true);
      pushShared('draft/pausedLeft', state.draft.pausedLeft);
      toast('Draft paused by the commissioner.');
    }
    save(); render();
  };
  const q = $('#poolQ');
  q.oninput = () => { poolFilter.q = q.value; poolFilter.limit = 60; refreshPool(); };
  $('#poolTeam').onchange = e => { poolFilter.team = e.target.value; poolFilter.limit = 60; refreshPool(); };
  $('#poolPos').onchange = e => { poolFilter.pos = e.target.value; poolFilter.limit = 60; refreshPool(); };
  bindPoolTable();
  $('#undoPick').onclick = () => {
    if (netOn() && !isCommissioner()) { toast('Only the commissioner can undo a pick'); return; }
    const resetClock = () => {
      if (state.settings.pickTimer) {
        state.draft.deadline = Date.now() + state.settings.pickTimer * 1000;
        pushShared('draft/deadline', state.draft.deadline);
      }
    };
    if (netOn()) {
      window.WCSync.txn('draft/picks', cur => { const a = toArr(cur); a.pop(); return a; })
        .then(res => { state.draft.picks = toArr(res.snapshot.val()); resetClock(); save(); render(); });
    } else {
      state.draft.picks.pop(); resetClock(); save(); render();
    }
  };
  const apBtn = $('#autoPick');
  if (apBtn) apBtn.onclick = () => {
    // strictly the on-clock manager's call — their list, their pick. The
    // Chairman can force it (DF's admin Force Pick) but gets the confirm.
    const mid = currentManagerId();
    if (mid == null) return;
    if (!canActFor(mid)) { toast(`It's ${managerName(mid)}'s pick — the group chat is watching you`); return; }
    if (!actGuard(mid, 'pick')) return;
    autoPick();
  };
}
function refreshPool() {
  const card = document.querySelector('.draft-layout .card');
  card.querySelector('.pool-wrap')?.remove();
  card.querySelector('.pool-table')?.remove();
  card.querySelector('.show-more')?.remove();
  card.insertAdjacentHTML('beforeend', poolTable());
  bindPoolTable();
  const q = $('#poolQ'); q.focus();
  q.setSelectionRange(q.value.length, q.value.length);
}
function bindPoolTable() {
  document.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => makePick(+b.dataset.pick));
  document.querySelectorAll('[data-auto]').forEach(b => b.onclick = () => {
    if (!whoami || whoami === -1) return;
    const pid = +b.dataset.auto;
    const list = toArr(state.autolists?.[whoami]);
    if (list.includes(pid)) { toast('Already on your list'); return; }
    setAutolist(whoami, [...list, pid]);
    toast(`${PLAYER_BY_ID[pid].name} added to your autopick list`);
  });
  document.querySelectorAll('[data-autodel]').forEach(b => b.onclick = () => {
    const arr = [...toArr(state.autolists?.[whoami])]; arr.splice(+b.dataset.autodel, 1); setAutolist(whoami, arr);
  });
  document.querySelectorAll('[data-autoup]').forEach(b => b.onclick = () => {
    const k = +b.dataset.autoup, arr = [...toArr(state.autolists?.[whoami])];
    [arr[k - 1], arr[k]] = [arr[k], arr[k - 1]]; setAutolist(whoami, arr);
  });
  document.querySelectorAll('[data-sort]').forEach(th => th.onclick = () => { poolFilter.sort = th.dataset.sort; refreshPool(); });
  bindColToggle(refreshPool);
  const sm = $('#showMore');
  if (sm) sm.onclick = () => { poolFilter.limit += 100; refreshPool(); };
}

function viewDraftRecap() {
  return `<div class="card"><h2>The Console &mdash; draft archive</h2>
    <p class="muted" style="margin-bottom:12px">All ${totalPicks()} picks are in. The recordings have been sealed.</p>
    <div class="pick-log" style="max-height:none">
    ${state.draft.picks.map(pk => {
      const p = PLAYER_BY_ID[pk.playerId];
      return `<div class="lrow"><span class="muted" style="width:38px">#${pk.n}</span><b style="width:130px">${esc(managerName(pk.managerId))}</b>${flagImg(p.team)} ${pname(p)} <span class="muted">· ${p.pos} · ${esc(p.team)}</span></div>`;
    }).join('')}
    </div></div>`;
}

/* ----- my team (lineups + transfers) ----- */
let teamView = { mid: null, gw: null, transferOut: null, pitchSel: null, showOpp: false };

function viewTeam() {
  if (teamView.mid == null) teamView.mid = (whoami && whoami !== -1) ? whoami : state.managers[0].id;
  if (teamView.gw == null) teamView.gw = currentGwIndex();
  const mid = teamView.mid, gw = teamView.gw;
  const squad = squadAt(mid, gw).sort((a, b) => POS_ORDER[a.pos] - POS_ORDER[b.pos] || rating(b) - rating(a));
  const xi = lineupFor(mid, gw);
  const counts = xiCounts(xi);
  const valid = xiValid(xi);
  // lineups lock at the gameweek deadline, like the real thing
  const locked = !demoMode && gwHasStarted(gw);
  const cur = currentGwIndex();
  const ownedNow = ownedIdsAt(cur);

  const countsBar = ['GK', 'DF', 'MF', 'FW'].map(pos => {
    const [lo, hi] = XI_RULES[pos];
    const ok = counts[pos] >= lo && counts[pos] <= hi;
    return `<span class="quota-pill ${ok ? 'full' : 'bad'}">${pos} ${counts[pos]} <span class="muted">(${lo}–${hi})</span></span>`;
  }).join('') + `<span class="quota-pill ${xi.length === 11 ? 'full' : 'bad'}">XI ${xi.length}/11</span>`;

  const notMine = netOn() && whoami && whoami !== -1 && mid !== whoami;
  return `
  ${notMine ? `<div class="card" style="margin-bottom:12px;border-color:var(--accent)"><p style="font-size:13px">&#128065;&#65039; You're looking at <b>${esc(teamName(mid))}</b> — ${esc(managerName(mid))}'s team${isCommissioner() ? '. Commissioner changes require confirmation.' : '. Look, don\'t touch.'} <button class="btn small" id="backToMine" style="margin-left:8px">Back to my team</button></p></div>` : ''}
  <div class="team-controls card">
    <select id="teamMgr">${state.managers.map(m => `<option value="${m.id}" ${m.id === mid ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
    <select id="teamGw">${GAMEWEEKS.map((g, i) => `<option value="${i}" ${i === gw ? 'selected' : ''}>GW${g.n} — ${g.label}${i === cur ? ' (current)' : ''}</option>`).join('')}</select>
    <span class="tag">${locked ? (gwIsOver(gw) ? 'Gameweek finished — locked' : 'Deadline passed — locked') : `Lineup open — locks ${new Date(gwFrom(gw)).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`}</span>
    <span class="tag">GW points: <b class="gold">&nbsp;${gwManagerPoints(mid, gw)}</b></span>
    <button class="tag" id="stadiumBtn" style="cursor:pointer" title="Rename your stadium">&#127967; ${esc(stadium(mid))}</button>
  </div>
  <div class="card" style="margin-bottom:18px">
    <h2 style="display:flex;align-items:center;gap:10px">The pitch <span class="muted" style="font-weight:400;font-size:12px">tap two players in a line to swap them — left back goes left</span>
      ${(() => {
        const opp = pairingsFor(gw).find(pr => pr.includes(mid));
        return opp ? `<button class="btn ghost small" id="showOpp" style="margin-left:auto">${teamView.showOpp ? 'Hide' : 'Show'} opponent</button>` : '';
      })()}
    </h2>
    ${(() => {
      if (!teamView.showOpp) return '';
      const pair = pairingsFor(gw).find(pr => pr.includes(mid));
      if (!pair) return '';
      const oppMid = pair[0] === mid ? pair[1] : pair[0];
      const oxi = lineupFor(oppMid, gw);
      return `<div class="mu-grid" style="margin-bottom:10px"><div class="mu-side"><h3 style="text-align:center">${esc(teamName(oppMid))} <b class="gold">${gwHasStarted(gw) ? gwManagerPoints(oppMid, gw) : projectedGwScore(oppMid, gw)}</b></h3>
        <div class="pitch mu-pitch">${['GK', 'DF', 'MF', 'FW'].map(pos => `<div class="pitch-row">${oxi.map(pid => PLAYER_BY_ID[pid]).filter(p => p.pos === pos).map(p => `<div class="pitch-chip mu-chip ${statusClass(p)}" data-pcard="${p.id}">${kitImg(p.team, p.pos === 'GK')}<span class="pitch-name">${esc(p.name)}</span></div>`).join('')}</div>`).join('')}</div>
      </div><div class="mu-side"><h3 style="text-align:center">${esc(teamName(mid))} <b class="gold">${gwHasStarted(gw) ? gwManagerPoints(mid, gw) : projectedGwScore(mid, gw)}</b></h3><p class="muted" style="font-size:11px;text-align:center">Your pitch is below — this is who you're up against.</p></div></div>`;
    })()}
    ${(() => {
      // browsing someone else's team: every chip opens the player card.
      // your own team: the NAME opens the card, the chip itself swaps.
      const browsing = !demoMode && whoami && whoami !== -1 && mid !== whoami;
      const chipAttrs = p => browsing ? `data-pcard="${p.id}" style="cursor:pointer"` : `data-pitch="${p.id}" draggable="${!locked}"`;
      // pic AND name open the player card everywhere; mid-swap taps still complete the swap
      const nameSpan = p => `<span class="pitch-name" ${browsing ? '' : `data-pcard="${p.id}" title="Tap for stats"`}>${esc(p.name)}</span>`;
      const pic = p => browsing ? kitImg(p.team, p.pos === 'GK') : kitImg(p.team, p.pos === 'GK', p);
      return `
    ${adStrip(mid * 37 + gw)}
    <div class="pitch">
      ${['GK', 'DF', 'MF', 'FW'].map(pos => `
        <div class="pitch-row">
          ${xi.map(pid => PLAYER_BY_ID[pid]).filter(p => p.pos === pos).map(p => `
            <div class="pitch-chip ${statusClass(p)} ${teamView.pitchSel === p.id ? 'sel' : ''}" ${chipAttrs(p)}>
              ${pic(p)}
              ${nameSpan(p)}
              ${!gwIsOver(gw) ? `<span class="pitch-vs">${nextOppHtml(p.team, GAMEWEEKS[gw].n)}</span>` : `<span class="pitch-vs">${gwPlayerPoints(p.id, gw)} pts</span>`}
            </div>`).join('') || '<span class="muted" style="font-size:11px">—</span>'}
        </div>`).join('')}
    </div>
    <div class="bench-strip">
      <span class="muted" style="font-size:11px;font-weight:700;align-self:center">BENCH</span>
      ${benchFor(mid, gw).map((p, k) => `
        <div class="pitch-chip benched ${statusClass(p)} ${teamView.pitchSel === p.id ? 'sel' : ''}" ${chipAttrs(p)} title="Auto-sub priority ${k + 1} — leftmost comes on first">
          <span class="tag" style="font-size:9px;padding:1px 5px">${k + 1}</span>
          ${pic(p)}
          ${nameSpan(p)}
        </div>`).join('')}
    </div>`;
    })()}
    <p class="muted" style="font-size:11px;margin-top:6px">Drag (or tap two players) to swap — within a line to arrange it, bench onto pitch to substitute, <b>two bench players to set auto-sub order</b> (leftmost comes on first).</p>
  </div>
  <div class="draft-layout">
    <div class="card">
      <h2>Starting XI — GW${GAMEWEEKS[gw].n} <span class="muted" style="font-weight:400">(tap to swap)</span></h2>
      <div class="quota-bar">${countsBar}</div>
      ${!valid ? '<p class="warn">Invalid XI — fix the highlighted limits. Scoring uses whoever is listed, but sort it out before kickoff.</p>' : ''}
      ${['GK', 'DF', 'MF', 'FW'].map(pos => `
        <h3>${POS_LABEL[pos]}</h3>
        ${squad.filter(p => p.pos === pos).map(p => {
          const starting = xi.includes(p.id);
          const pts = gwPlayerPoints(p.id, gw);
          return `<div class="squad-row lineup-row ${statusClass(p)} ${starting ? 'starting' : 'benched'}" data-toggle="${p.id}" ${locked ? '' : 'style="cursor:pointer"'}>
            <span class="shirt-no" data-num="${p.id}" title="Click to assign a squad number">${shirtNum(mid, p.id)}</span>
            <span class="pos-badge pos-${p.pos}">${p.pos}</span>${kitImg(p.team, p.pos === 'GK', p)}
            <span><span data-pcard="${p.id}" style="cursor:pointer" title="Tap for stats">${esc(p.name)}</span> ${statusChip(p)}</span>
            <span class="muted" style="font-size:11.5px">${esc(p.club)}</span>
            <span class="sp-pts ${pts > 0 ? 'gold' : 'muted'}">${pts}</span>
            <span class="xi-chip">${starting ? 'XI' : 'bench'}</span>
          </div>`;
        }).join('')}`).join('')}
    </div>
    <div class="draft-side">
      <div class="card">
        <h2>Transfers ${toArr(state.trades).some(t => t.status === 'pending' && t.to === mid) ? '<span class="tag live-tag">OFFER IN</span>' : ''}</h2>
        <p class="muted" style="font-size:12.5px;margin-bottom:10px">The Trough, waivers and the Trade desk live in the <b>Transfers</b> tab.</p>
        <button class="btn small" id="goTransfers">Open Transfers</button>
      </div>
      <div class="card">
        <h2>Form</h2>
        ${(() => {
          const rows = [];
          for (let i = 0; i < REGULAR_GWS; i++) {
            if (gwStatus(i) !== 'final') continue;
            const pr = pairingsFor(i).find(x => x.includes(mid));
            if (!pr) continue;
            const op = pr[0] === mid ? pr[1] : pr[0];
            const pm = gwManagerPoints(mid, i), po = gwManagerPoints(op, i);
            rows.push({ i, op, pm, po, res: pm > po ? 'W' : pm < po ? 'L' : 'D' });
          }
          if (!rows.length) return '<span class="muted" style="font-size:12.5px">No results yet. All to play for.</span>';
          const strip = rows.slice(-8).map(r => `<span class="form-pill form-${r.res}" title="GW${GAMEWEEKS[r.i].n}">${r.res}</span>`).join('');
          const season = rows.reduce((t, r) => t + r.pm, 0);
          return `<div style="margin-bottom:10px">${strip}</div>` +
            rows.slice(-6).reverse().map(r => `<div class="lrow" style="font-size:12.5px;justify-content:space-between"><span><span class="form-pill form-${r.res}">${r.res}</span> GW${GAMEWEEKS[r.i].n} v ${esc(teamName(r.op))}</span><b>${r.pm}&ndash;${r.po}</b></div>`).join('') +
            `<p class="muted" style="font-size:11.5px;margin-top:8px">Season points: <b style="color:var(--text)">${managerPoints(mid)}</b> &middot; H2H scoring: ${season}</p>`;
        })()}
      </div>
    </div>
  </div>`;
}

function bindTeam() {
  $('#teamMgr').onchange = e => { teamView.mid = +e.target.value; teamView.transferOut = null; render(); };
  const btm = $('#backToMine');
  if (btm) btm.onclick = () => { teamView.mid = whoami; teamView.transferOut = null; render(); };
  $('#teamGw').onchange = e => { teamView.gw = +e.target.value; render(); };
  const gw = teamView.gw, mid = teamView.mid;
  if (demoMode || !gwHasStarted(gw)) {
    document.querySelectorAll('[data-toggle]').forEach(row => row.onclick = () => {
      if (!actGuard(mid, 'lineup')) return;
      const pid = +row.dataset.toggle;
      const xi = [...lineupFor(mid, gw)];
      const i = xi.indexOf(pid);
      if (i >= 0) xi.splice(i, 1);
      else {
        if (xi.length >= 11) { toast('XI is full — bench someone first'); return; }
        xi.push(pid);
      }
      (state.lineups[mid] = state.lineups[mid] || {})[gw] = xi;
      pushShared(`lineups/${mid}/${gw}`, xi);
      save(); render();
    });
  }
  const so = $('#showOpp');
  if (so) so.onclick = () => { teamView.showOpp = !teamView.showOpp; render(); };
  // --- stadium naming ---
  const sb2 = $('#stadiumBtn');
  if (sb2) sb2.onclick = () => {
    if (!actGuard(mid, 'stadium')) return;
    const v = prompt(`Name ${teamName(mid)}'s stadium:`, stadium(mid));
    if (v == null || !v.trim()) return;
    state.managers.find(m => m.id === mid).stadium = v.trim().slice(0, 40);
    pushShared('managers', state.managers);
    save(); render();
    toast(`${v.trim()} — naming rights sold for nothing.`);
  };
  // --- the pitch: swap two players (tap-tap or drag-drop) ---
  const pitchSwap = (pidA, pidB) => {
    if (pidA === pidB) return;
    const a = PLAYER_BY_ID[pidA], b = PLAYER_BY_ID[pidB];
    const xi2 = [...lineupFor(mid, gw)];
    const ia = xi2.indexOf(pidA), ib = xi2.indexOf(pidB);
    if (ia >= 0 && ib >= 0) {
      // both on the pitch: arrange within a line
      if (a.pos !== b.pos) { toast(`Same line only — ${a.name} is a ${a.pos}, ${b.name} is a ${b.pos}`); return; }
      [xi2[ia], xi2[ib]] = [xi2[ib], xi2[ia]];
    } else if (ia >= 0 || ib >= 0) {
      // substitution: pitch player off, bench player on
      const inIdx = ia >= 0 ? ia : ib;
      const onPid = ia >= 0 ? pidA : pidB, offPid = ia >= 0 ? pidB : pidA;
      const trial = [...xi2];
      trial[inIdx] = offPid;
      if (!xiValid(trial)) { toast('That substitution breaks the XI shape (1 GK, 3–5 DF, 2–5 MF, 1–3 FW)'); return; }
      xi2[inIdx] = offPid;
      // the departing starter inherits the incoming sub's bench slot
      setBenchOrder(mid, gw, benchFor(mid, gw).map(p => p.id === offPid ? onPid : p.id));
    } else {
      // two bench players: swap their auto-sub priority
      const bo = benchFor(mid, gw).map(p => p.id);
      const ka = bo.indexOf(pidA), kb = bo.indexOf(pidB);
      if (ka < 0 || kb < 0) return;
      [bo[ka], bo[kb]] = [bo[kb], bo[ka]];
      setBenchOrder(mid, gw, bo);
      teamView.pitchSel = null;
      save(); render();
      return;
    }
    (state.lineups[mid] = state.lineups[mid] || {})[gw] = xi2;
    pushShared(`lineups/${mid}/${gw}`, xi2);
    teamView.pitchSel = null;
    save(); render();
  };
  const pitchGuard = () => {
    if (!demoMode && gwHasStarted(gw)) { toast('Lineup is locked for this gameweek'); return false; }
    return actGuard(mid, 'lineup');
  };
  let dragPid = null;
  document.querySelectorAll('[data-pitch]').forEach(chip => {
    chip.onclick = () => {
      if (!pitchGuard()) return;
      const pid = +chip.dataset.pitch;
      if (teamView.pitchSel == null) { teamView.pitchSel = pid; render(); return; }
      if (teamView.pitchSel === pid) { teamView.pitchSel = null; render(); return; }
      pitchSwap(teamView.pitchSel, pid);
    };
    chip.ondragstart = e => {
      if (!pitchGuard()) { e.preventDefault(); return; }
      dragPid = +chip.dataset.pitch;
      e.dataTransfer.effectAllowed = 'move';
    };
    chip.ondragover = e => { e.preventDefault(); chip.classList.add('dragover'); };
    chip.ondragleave = () => chip.classList.remove('dragover');
    chip.ondrop = e => {
      e.preventDefault();
      chip.classList.remove('dragover');
      if (dragPid != null) pitchSwap(dragPid, +chip.dataset.pitch);
      dragPid = null;
    };
  });
  // --- custom squad numbers ---
  document.querySelectorAll('[data-num]').forEach(el => el.onclick = e => {
    e.stopPropagation();
    if (!actGuard(mid, 'squad numbers')) return;
    const pid = +el.dataset.num;
    const cur2 = currentGwIndex();
    const v = prompt(`Squad number for ${PLAYER_BY_ID[pid].name} (1–99):`, shirtNum(mid, pid));
    if (v == null) return;
    const n = Math.round(+v);
    if (!n || n < 1 || n > 99) { toast('Numbers 1–99 only'); return; }
    const clash = squadAt(mid, cur2).find(x => x.id !== pid && +shirtNum(mid, x.id) === n);
    if (clash) { toast(`${n} is taken by ${clash.name}`); return; }
    (state.shirtNums[mid] = state.shirtNums[mid] || {})[pid] = n;
    pushShared(`shirtNums/${mid}`, state.shirtNums[mid]);
    save(); render();
    toast(`${PLAYER_BY_ID[pid].name} takes the number ${n} shirt`);
  });  const gt = $('#goTransfers');
  if (gt) gt.onclick = () => { state.view = 'transfers'; save(); render(); };
}

/* ---------------- the Transfers hub (Draft Fantasy layout) ---------------- */
let transfersView = { tab: 'trough', out: null, pos: '', club: '', scope: 'free', sort: 'pts', limit: 20 };
function viewTransfers() {
  const mid = (whoami && whoami !== -1) ? whoami : state.managers[0].id;
  const cur = currentGwIndex();
  const ownedNow = ownedIdsAt(cur);
  const tabs = [['trough', 'The Trough & Waivers'], ['trades', 'Trade desk'], ['history', 'History'], ['order', 'Waiver order']];
  const tab = transfersView.tab;
  const pendingIn = toArr(state.trades).filter(t => t.status === 'pending' && t.to === mid).length;
  const head = `<div class="team-controls card">
    ${tabs.map(([id, label]) => `<button class="btn small ${tab === id ? '' : 'ghost'}" data-trtab="${id}">${label}${id === 'trades' && pendingIn ? ` <span class="tag live-tag">${pendingIn}</span>` : ''}</button>`).join('')}
    <span class="tag" style="margin-left:auto">acting as ${esc(managerName(mid))}</span>
  </div>`;
  if (tab === 'trough') {
    const wd = state.windowDraft;
    const arrivals = lockedArrivals();
    let wdCard = '';
    if (wd?.status === 'live') {
      const actor = wdActor();
      const ord = wd.order;
      const lap = Math.floor(wd.turn / ord.length);
      const lapOrd = lap % 2 ? [...ord].reverse() : ord;
      wdCard = `<div class="card" style="margin-bottom:14px">
        <h2>The Window Draft <span class="tag live-tag"><span class="rec"></span>LIVE</span> <span class="muted" style="font-weight:400;font-size:12px">new arrivals only &middot; snakes backwards from the last pick &middot; a full lap of passes ends it</span></h2>
        <div class="order-strip" style="margin:8px 0">${lapOrd.map(id => `<span class="order-chip ${id === actor ? 'now' : ''}">${esc(managerName(id))}</span>`).join('<span class="muted" style="align-self:center">›</span>')}<span class="tag" style="margin-left:10px">Lap ${lap + 1}${lap % 2 ? ' (reversed)' : ''}</span></div>
        <p style="font-size:13px"><b>${esc(managerName(actor))}</b> is on the clock. Sign one of the new arrivals (someone goes out), or pass.</p>
        ${canActFor(actor) ? `
        <select id="wdOut" style="width:100%;max-width:420px;margin:8px 0;display:block">
          <option value="">Player out…</option>
          ${squadAt(actor, cur).sort((a, b) => POS_ORDER[a.pos] - POS_ORDER[b.pos]).map(pp => `<option value="${pp.id}">${pp.pos} — ${esc(pp.name)} (${esc(pp.club)})</option>`).join('')}
        </select>` : `<p class="muted" style="font-size:12px">Lean on them in the group chat.</p>`}
        <div class="pick-log" style="max-height:320px">
          ${[...arrivals].sort(metricSort('pts')).map(p => `<div class="lrow"><span class="pos-badge pos-${p.pos}">${p.pos}</span>${photoImg(p)} ${pname(p)} ${statusChip(p)} <span class="muted" style="font-size:11px">${esc(p.club)} · ${metricsFor(p).pts} pts</span>
            <button class="btn small" style="margin-left:auto" data-wdin="${p.id}" ${canActFor(actor) ? '' : `disabled title="It's ${esc(managerName(actor))}'s turn"`}>Sign</button></div>`).join('') || '<span class="muted">No arrivals left.</span>'}
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
          ${canActFor(actor) ? `<button class="btn ghost small" id="wdPass">Pass</button>` : ''}
          ${!netOn() || isCommissioner() ? `<button class="btn ghost small" id="wdEnd">End it — leftovers to the Trough</button>` : ''}
        </div>
        ${wd.picks?.length ? `<p class="muted" style="font-size:11.5px;margin-top:8px"><b style="color:var(--text)">So far:</b> ${wd.picks.map(k => `${esc(managerName(k.mid))} → ${esc(PLAYER_BY_ID[k.in]?.name || '?')}`).join(' · ')}</p>` : ''}
      </div>`;
    } else if (arrivals.length) {
      wdCard = `<div class="card" style="margin-bottom:14px">
        <h2>The Window <span class="tag">&#128274; ${arrivals.length} new arrival${arrivals.length > 1 ? 's' : ''} locked</span></h2>
        <p class="muted" style="font-size:12.5px">Anyone who joined a Premier League club after draft night is locked until the transfer window shuts. The Chairman then runs the <b>Window Draft</b> — first pick goes to whoever picked last on draft night, snaking back up. Leftovers spill into the Trough.</p>
        ${netOn() && !isCommissioner() ? '' : `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
          <button class="btn small" id="wdStart">Start the Window Draft</button>
          <button class="btn ghost small" id="wdRelease">Skip it — release all to the Trough</button>
        </div><p class="muted" style="font-size:10.5px;margin-top:4px">Chairman's office. Wait for the window to actually shut.</p>`}
      </div>`;
    }
    const ctl = waiverControl();
    const claims = myClaims(mid);
    const nextRun = nextWaiverRun(Math.max(lastWaiverRun(), Date.now()));
    const status = ctl === 'closed' ? '<span class="tag">CLOSED by the Chairman</span>'
      : ctl === 'open' ? '<span class="tag">THROWN OPEN — everything is free</span>'
      : `<span class="tag">waivers process ${nextRun.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC</span>`;
    const claimRows = claims.map((c, k) => `
      <div class="lrow" style="font-size:12.5px">
        <span class="muted">#${k + 1}</span> <b>${pname(PLAYER_BY_ID[c.in])}</b>
        <span class="muted">in, ${pname(PLAYER_BY_ID[c.out])} out</span>
        <span style="margin-left:auto;display:flex;gap:4px">
          ${k > 0 ? `<button class="btn ghost small" data-claimup="${k}" title="Raise priority">&#9650;</button>` : ''}
          <button class="btn ghost small" data-claimdel="${k}" title="Withdraw">&#10005;</button>
        </span>
      </div>`).join('');
    return `${head}${wdCard}<div class="card">
      <h2>Waivers &amp; The Trough ${status}</h2>
      <p class="muted" style="font-size:12px;margin-bottom:10px">Players on waivers need a claim — ranked, blind, resolved in reverse table order (win one, go to the back). Everyone else is free to sign instantly. Squads stay at ${state.settings.squadSize}: someone always goes out.</p>
      ${claims.length ? `<h3>${esc(managerName(mid))}'s claims</h3>${claimRows}` : ''}
      ${ctl === 'closed' ? '<p class="muted" style="font-size:12.5px">The Trough is closed. Complaints to the group chat.</p>' : `
      <select id="trOut" style="width:100%;margin:8px 0;max-width:420px">
        <option value="">Player out…</option>
        ${squadAt(mid, cur).sort((a, b) => POS_ORDER[a.pos] - POS_ORDER[b.pos]).map(pp => `<option value="${pp.id}" ${transfersView.out === pp.id ? 'selected' : ''}>${pp.pos} — ${esc(pp.name)} (${esc(pp.club)})</option>`).join('')}
      </select>
      <input type="text" id="trSearch" placeholder="Search the Trough — ${PLAYERS.length - ownedNow.size} players sniffing about…" style="width:100%;max-width:420px;margin-bottom:8px;display:block">
      <div id="trResults" class="pick-log" style="max-height:600px"></div>`}
      ${netOn() && isCommissioner() ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
        <button class="btn small" id="runWaivers">Run waivers now</button>
        <button class="btn ghost small" id="ctlOpen" ${ctl === 'open' ? 'disabled' : ''}>Open Trough</button>
        <button class="btn ghost small" id="ctlClosed" ${ctl === 'closed' ? 'disabled' : ''}>Close Trough</button>
        <button class="btn ghost small" id="ctlAuto" ${ctl === 'auto' ? 'disabled' : ''}>Follow schedule</button>
      </div><p class="muted" style="font-size:10.5px;margin-top:4px">Chairman's office. Overrides apply to everyone, immediately.</p>` : ''}
    </div>`;
  }
  if (tab === 'trades') {
    const block = state.managers.flatMap(m => blockList(m.id).map(pid => ({ mid: m.id, p: PLAYER_BY_ID[pid] })).filter(x => x.p));
    return `${head}<div class="card" style="margin-bottom:14px">
      <h2>The Trade Block <span class="muted" style="font-weight:400;font-size:12px">publicly up for grabs — make an offer</span></h2>
      ${block.length ? block.map(({ mid: bm, p }) => `<div class="lrow" style="font-size:12.5px">
        <span class="pos-badge pos-${p.pos}">${p.pos}</span>${photoImg(p)} ${pname(p)} <span class="muted" style="font-size:11px">${esc(p.club)} · ${metricsFor(p).pts} pts</span>
        <b style="margin-left:6px">${esc(teamName(bm))}</b>
        <span style="margin-left:auto">${bm === mid
          ? `<button class="btn ghost small" data-unblock="${p.id}">Delist</button>`
          : `<button class="btn small" data-blocktrade="${bm}:${p.id}">Make an offer</button>`}</span>
      </div>`).join('') : '<p class="muted" style="font-size:12.5px">Nobody’s listed anyone. Open your player cards and put someone on the block.</p>'}
    </div>
    <div class="card">
      <h2>Trade desk</h2>
      <p class="muted" style="font-size:12px;margin-bottom:10px">Propose a swap; it executes the instant the other manager accepts.</p>
      ${toArr(state.trades).filter(t => t.status === 'pending' && (t.to === mid || t.from === mid)).map(t => `
        <div class="lrow" style="font-size:12.5px;flex-wrap:wrap">
          <span><b>${esc(managerName(t.from))}</b> gives <b>${esc(tradeNames(tGive(t)))}</b> for <b>${esc(tradeNames(tGet(t)))}</b>${t.terms ? `<br><span class="muted" style="font-size:11px">&#128220; ${esc(t.terms)}</span>` : ''}</span>
          <span style="margin-left:auto;display:flex;gap:4px">
            ${t.to === mid ? `<button class="btn small" data-tracc="${t.id}">Accept</button><button class="btn ghost small" data-trrej="${t.id}">Reject</button>`
              : `<button class="btn ghost small" data-trwd="${t.id}">Withdraw</button>`}
          </span>
        </div>`).join('') || '<p class="muted" style="font-size:12.5px">No offers on the table.</p>'}
      <select id="tradeWith" style="width:100%;max-width:420px;margin:8px 0;display:block">
        <option value="">Trade ${esc(managerName(mid))} with…</option>
        ${state.managers.filter(m => m.id !== mid).map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}
      </select>
      <div id="tradePickers" style="max-width:420px"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h2>The Covenant Register <span class="tag">the offline bits, on the record</span></h2>
      <p class="muted" style="font-size:12px;margin-bottom:10px">Loan-backs, first refusals, "you owe me one" — record it here so nobody can deny it in GW30. Witnessed by the Committee. Enforced by the group chat.</p>
      ${[...toArr(state.covenants)].reverse().map(c => `<div class="lrow" style="font-size:12.5px;flex-wrap:wrap">
        <span class="muted">GW${c.gw ?? '?'}</span>
        <span><b>${esc(managerName(c.from))}</b> &harr; <b>${esc(managerName(c.to))}</b>: &#128220; ${esc(c.text)}</span>
      </div>`).join('') || '<p class="muted" style="font-size:12px">No covenants recorded. Suspiciously clean.</p>'}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <select id="covWith" style="min-width:150px">
          <option value="">With…</option>
          ${state.managers.filter(m => m.id !== mid).map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}
        </select>
        <input type="text" id="covText" maxlength="200" placeholder="The agreement, verbatim" style="flex:1;min-width:220px">
        <button class="btn small" id="covAdd">Record it</button>
      </div>
    </div>`;
  }
  if (tab === 'history') {
    const rows = [...state.transfers].reverse().map(t => `<div class="lrow" style="font-size:12.5px">
      <span class="muted" style="width:44px">GW${GAMEWEEKS[t.gw].n}</span>
      <span class="tag">${t.trade ? 'trade' : t.waiver ? 'waiver' : t.windowDraft ? 'window' : 'trough'}</span>
      <b style="min-width:120px">${esc(teamName(t.managerId))}</b>
      ${pname(PLAYER_BY_ID[t.outId])} <span class="muted">→</span> <b>${pname(PLAYER_BY_ID[t.inId])}</b>
    </div>`).join('');
    return `${head}<div class="card"><h2>Every move, on the record</h2>${rows || '<p class="muted">Nothing yet. Cowards.</p>'}</div>`;
  }
  // order
  const order = waiverOrder(cur);
  const claimCounts = state.managers.map(m => ({ m, n: myClaims(m.id).length }));
  const waiverHist = state.transfers.filter(t => t.waiver);
  return `${head}<div class="card">
    <h2>Waiver order <span class="tag">bottom of the table feeds first</span></h2>
    ${order.map((om, k) => `<div class="lrow"><span class="muted">#${k + 1}</span> <b>${esc(teamName(om))}</b> <span class="muted" style="font-size:11.5px">${esc(managerName(om))}</span>
      <span style="margin-left:auto" class="muted">${claimCounts.find(c => c.m.id === om)?.n || 0} claim${(claimCounts.find(c => c.m.id === om)?.n || 0) === 1 ? '' : 's'} pending</span></div>`).join('')}
    <p class="muted" style="font-size:11px;margin-top:8px">Claims are blind — counts are public, targets are not. Next run: ${nextWaiverRun(Math.max(lastWaiverRun(), Date.now())).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC.</p>
    <h3 style="margin-top:16px">Waiver history</h3>
    ${waiverHist.length ? [...waiverHist].reverse().map(t => `<div class="lrow" style="font-size:12.5px"><span class="muted">GW${GAMEWEEKS[t.gw].n}</span> <b>${esc(teamName(t.managerId))}</b> claimed ${pname(PLAYER_BY_ID[t.inId])} <span class="muted">(${pname(PLAYER_BY_ID[t.outId])} out)</span></div>`).join('') : '<p class="muted" style="font-size:12px">No claims have landed yet.</p>'}
  </div>`;
}
function bindTransfers() {
  const mid = (whoami && whoami !== -1) ? whoami : state.managers[0].id;
  const cur = currentGwIndex();
  document.querySelectorAll('[data-trtab]').forEach(b => b.onclick = () => { transfersView.tab = b.dataset.trtab; render(); });
  const cov = $('#covAdd');
  if (cov) cov.onclick = () => {
    if (!actGuard(mid, 'covenant')) return;
    const to = +$('#covWith').value, text = $('#covText').value.trim();
    if (!to || !text) { toast('Pick a counterparty and state the nonsense'); return; }
    state.covenants = [...toArr(state.covenants), { id: Date.now() + '-' + mid, from: mid, to, text: text.slice(0, 200), t: Date.now(), gw: GAMEWEEKS[cur].n }];
    pushShared('covenants', state.covenants);
    save(); render();
    toast('Recorded. It is now canon.');
  };
  // --- the Window Draft ---
  const wds = $('#wdStart');
  if (wds) wds.onclick = () => {
    const ord = [...state.draft.order].reverse();
    if (!ord.length) { toast('No draft order on record'); return; }
    if (!confirm(`Start the Window Draft? Order snakes backwards from draft night: ${ord.map(managerName).join(' › ')}. It runs until a full lap of passes.`)) return;
    state.windowDraft = { status: 'live', order: ord, turn: 0, passes: 0, picks: [] };
    pushShared('windowDraft', state.windowDraft);
    save(); render();
  };
  const wdr = $('#wdRelease');
  if (wdr) wdr.onclick = () => { if (confirm('Release every new arrival straight into the Trough — no Window Draft?')) wdFinish(); };
  const wde = $('#wdEnd');
  if (wde) wde.onclick = () => { if (confirm('End the Window Draft? Remaining arrivals go to the Trough.')) wdFinish(); };
  const wdp = $('#wdPass');
  if (wdp) wdp.onclick = () => { if (!actGuard(wdActor(), 'window draft')) return; toast(`${managerName(wdActor())} passes.`); wdAdvance(true); };
  document.querySelectorAll('[data-wdin]').forEach(b => b.onclick = () => {
    const actor = wdActor();
    if (!actGuard(actor, 'window draft')) return;
    const outId = +($('#wdOut')?.value || 0);
    if (!outId) { toast('Pick who goes out first'); return; }
    const inP = PLAYER_BY_ID[+b.dataset.wdin];
    if (!squadShapeOk([...squadAt(actor, cur).filter(x => x.id !== outId), inP])) { toast('Breaks the squad position limits'); return; }
    state.transfers.push({ managerId: actor, outId, inId: inP.id, gw: cur, n: state.transfers.length + 1, t: Date.now(), windowDraft: true });
    const lu = state.lineups[actor]?.[cur];
    if (lu) state.lineups[actor][cur] = lu.filter(id => id !== outId);
    pushShared('transfers', state.transfers);
    if (state.lineups[actor]?.[cur]) pushShared(`lineups/${actor}/${cur}`, state.lineups[actor][cur]);
    state.windowDraft.picks.push({ mid: actor, in: inP.id, out: outId });
    toast(`${inP.name} signed in the Window Draft. ${PLAYER_BY_ID[outId]?.name} makes way.`);
    wdAdvance(false);
  });
  // --- waivers & the Trough ---
  const out = $('#trOut'), search = $('#trSearch'), results = $('#trResults');
  // claim list management (withdraw / reprioritise)
  document.querySelectorAll('[data-claimdel]').forEach(b => b.onclick = () => {
    if (!actGuard(mid, 'waiver claims')) return;
    const arr = [...myClaims(mid)]; arr.splice(+b.dataset.claimdel, 1); setClaims(mid, arr);
  });
  document.querySelectorAll('[data-claimup]').forEach(b => b.onclick = () => {
    if (!actGuard(mid, 'waiver claims')) return;
    const k = +b.dataset.claimup, arr = [...myClaims(mid)];
    [arr[k - 1], arr[k]] = [arr[k], arr[k - 1]]; setClaims(mid, arr);
  });
  // Chairman's office
  const rw = $('#runWaivers');
  if (rw) rw.onclick = () => { if (confirm('Run waivers now for everyone? Claims resolve in reverse table order and the Trough opens.')) processWaivers(true); };
  ['open', 'closed', 'auto'].forEach(m => { const b = $(`#ctl${m[0].toUpperCase()}${m.slice(1)}`); if (b) b.onclick = () => setWaiverControl(m); });
  if (out) {
    const cur = currentGwIndex();
    out.onchange = () => { transfersView.out = +out.value || null; renderTrResults(); };
    search.oninput = renderTrResults;
    function renderTrResults() {
      const q = normName(search.value || '');
      const owned = ownedIdsAt(cur);
      const outP = transfersView.out ? PLAYER_BY_ID[transfersView.out] : null;
      const squadAfterOut = squadAt(mid, cur).filter(p => !outP || p.id !== outP.id);
      const claimedIds = new Set(myClaims(mid).map(c => c.in));
      const ownedBy = {};
      for (const mm of state.managers) for (const sp of squadAt(mm.id, cur)) ownedBy[sp.id] = mm.id;
      let pool = transfersView.scope === 'all' ? [...PLAYERS] : PLAYERS.filter(p => !owned.has(p.id));
      if (transfersView.pos) pool = pool.filter(p => p.pos === transfersView.pos);
      if (transfersView.club) pool = pool.filter(p => p.team === transfersView.club);
      if (q) pool = pool.filter(p => normName(p.name).includes(q) || normName(p.team).includes(q) || normName(p.club).includes(q));
      const s = transfersView.sort;
      const live = seasonHasStats();
      const cols = STAT_COLS(live);
      pool.sort(metricSort(s));
      const total = pool.length;
      const shown = pool.slice(0, transfersView.limit);
      const hint = outP ? `<div class="muted" style="font-size:11.5px;padding:2px 0 6px">Making room for ${esc(outP.name)} (${outP.pos}) to leave:</div>`
        : '<div class="muted" style="font-size:11.5px;padding:2px 0 6px">Browsing the Trough — choose a player out above to unlock signing and claiming. Tap a column to sort.</div>';
      const table = `
      <div style="overflow-x:auto">
      <table class="pool-table">
        <thead><tr>
          <th data-trsort="name">Player</th><th></th>
          ${cols.map(c => c.sortable === false ? `<th class="num" title="${esc(c.t)}">${c.h}</th>` : `<th class="num" data-trsort="${c.k}" title="${esc(c.t)}">${c.h} ${s === c.k ? '▾' : ''}</th>`).join('')}<th></th>
        </tr></thead>
        <tbody>${shown.map(p => {
          const ownerMid = ownedBy[p.id];
          const locked = !ownerMid && arrivalLocked(p);
          const waiv = !ownerMid && !locked && onWaivers(p);
          const ok = !ownerMid && !locked && outP && squadShapeOk([...squadAfterOut, p]) && !claimedIds.has(p.id);
          const why = locked ? 'New arrival — locked until the window shuts, then the Window Draft'
            : !outP ? 'Pick who goes out first' : claimedIds.has(p.id) ? 'Already claimed' : 'Breaks the squad position limits';
          const m = metricsFor(p);
          const action = ownerMid
            ? (ownerMid === mid ? '<span class="muted" style="font-size:11px">yours</span>' : `<button class="btn ghost small" data-trtrade="${ownerMid}:${p.id}" title="Open the trade desk with ${esc(managerName(ownerMid))}">Trade</button>`)
            : `<button class="btn small ${waiv || locked ? 'ghost' : ''}" data-trin="${p.id}" data-waiv="${waiv ? 1 : 0}" ${ok ? '' : `disabled title="${why}"`}>${locked ? '&#128274;' : waiv ? 'Claim' : 'Sign'}</button>`;
          return `<tr class="${statusClass(p)}">
            <td><div class="pcell">${photoImg(p)}<div><div class="pname">${esc(p.name)}</div><div class="pclub">${flagImg(p.team)} ${esc(p.club)} · <span class="pos-badge pos-${p.pos}">${p.pos}</span>${ownerMid ? ` · <b style="color:var(--text)">${esc(teamName(ownerMid))}</b>${onBlock(p.id) ? ' · <span style="color:var(--accent)">&#128276; on the block</span>' : ''}` : locked ? ' · <span class="muted">&#128274; new arrival</span>' : waiv ? ' · <span class="muted">on waivers</span>' : ''}</div></div></div></td>
            <td>${statusChip(p)}</td>
            ${cols.map(c => `<td class="num${c.cls || ''}">${c.v(m, p)}</td>`).join('')}
            <td>${action}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
      ${total > transfersView.limit ? `<div class="show-more"><button class="btn ghost small" id="trMore">Show more</button> <button class="btn ghost small" id="trAll">Show all ${total}</button></div>` : ''}`;
      results.innerHTML = hint + `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 8px;align-items:center">
        ${['', 'GK', 'DF', 'MF', 'FW'].map(pp => `<button class="btn small ${transfersView.pos === pp ? '' : 'ghost'}" data-trpos="${pp}">${pp || 'All'}</button>`).join('')}
        <select id="trClub" style="padding:6px 8px;font-size:12px">
          <option value="">All clubs</option>
          ${TEAMS.map(t => `<option value="${esc(t.name)}" ${transfersView.club === t.name ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select>
        <span style="width:8px"></span>
        <button class="btn small ${transfersView.scope !== 'all' ? '' : 'ghost'}" data-trscope="free">Free agents</button>
        <button class="btn small ${transfersView.scope === 'all' ? '' : 'ghost'}" data-trscope="all" title="Show owned players too, Draft Fantasy style">Everyone</button>
        ${colToggleHtml(live)}
      </div>` + (shown.length ? table : '<span class="muted">The Trough is empty. Somehow.</span>');
      const clubSel = results.querySelector('#trClub');
      if (clubSel) clubSel.onchange = () => { transfersView.club = clubSel.value; transfersView.limit = 20; renderTrResults(); };
      results.querySelectorAll('[data-trpos]').forEach(b => b.onclick = () => { transfersView.pos = b.dataset.trpos; transfersView.limit = 20; renderTrResults(); });
      results.querySelectorAll('[data-trscope]').forEach(b => b.onclick = () => { transfersView.scope = b.dataset.trscope; transfersView.limit = 20; renderTrResults(); });
      results.querySelectorAll('[data-trtrade]').forEach(b => b.onclick = () => {
        const [other, get] = b.dataset.trtrade.split(':').map(Number);
        transfersView.tab = 'trades'; window._tradeFocus = { other, get }; render();
      });
      results.querySelectorAll('[data-trsort]').forEach(th => th.onclick = () => { transfersView.sort = th.dataset.trsort; renderTrResults(); });
      bindColToggle(renderTrResults);
      const more = results.querySelector('#trMore');
      if (more) more.onclick = () => { transfersView.limit += 50; renderTrResults(); };
      const showAll = results.querySelector('#trAll');
      if (showAll) showAll.onclick = () => { transfersView.limit = 9999; renderTrResults(); };
      results.querySelectorAll('[data-trin]').forEach(b => b.onclick = () => {
        if (!actGuard(mid, 'squad')) return;
        const inId = +b.dataset.trin, outId = transfersView.out;
        const inP = PLAYER_BY_ID[inId];
        if (b.dataset.waiv === '1') {
          setClaims(mid, [...myClaims(mid), { in: inId, out: outId }]);
          transfersView.out = null;
          toast(`Claim lodged: ${inP.name}. Resolves when waivers run.`);
          return;
        }
        if (!squadShapeOk([...squadAt(mid, cur).filter(x => x.id !== outId), inP])) { toast('Breaks the squad position limits'); return; }
        state.transfers.push({ managerId: mid, outId, inId, gw: cur, n: state.transfers.length + 1, t: Date.now() });
        const lu = state.lineups[mid]?.[cur];
        if (lu) state.lineups[mid][cur] = lu.filter(id => id !== outId);
        pushShared('transfers', state.transfers);
        if (state.lineups[mid]?.[cur]) pushShared(`lineups/${mid}/${cur}`, state.lineups[mid][cur]);
        transfersView.out = null;
        save(); render();
        toast(`${inP.name} signed from the Trough. First come, first served.`);
      });
    }
    if (window._troughFocus) {
      search.value = window._troughFocus;
      window._troughFocus = null;
      renderTrResults();
    } else renderTrResults();
  }
  // --- trade desk: propose / accept / reject / withdraw ---
  document.querySelectorAll('[data-tracc]').forEach(b => b.onclick = () => {
    const tr = toArr(state.trades).find(x => x.id === b.dataset.tracc);
    if (!tr) return;
    if (!actGuard(tr.to, 'trade')) return;
    respondTrade(tr.id, true);
  });
  document.querySelectorAll('[data-trrej]').forEach(b => b.onclick = () => {
    const tr = toArr(state.trades).find(x => x.id === b.dataset.trrej);
    if (!tr) return;
    if (!actGuard(tr.to, 'trade')) return;
    respondTrade(tr.id, false);
  });
  document.querySelectorAll('[data-trwd]').forEach(b => b.onclick = () => {
    const tr = toArr(state.trades).find(x => x.id === b.dataset.trwd);
    if (!tr) return;
    if (!actGuard(tr.from, 'trade')) return;
    tr.status = 'withdrawn';
    pushShared('trades', state.trades);
    save(); render();
    toast('Offer withdrawn. Never happened.');
  });
  // trade block: delist your own, make an offer for theirs
  document.querySelectorAll('[data-unblock]').forEach(b => b.onclick = () => {
    if (!actGuard(mid, 'trade block')) return;
    toggleBlock(mid, +b.dataset.unblock);
  });
  document.querySelectorAll('[data-blocktrade]').forEach(b => b.onclick = () => {
    const [other, get] = b.dataset.blocktrade.split(':').map(Number);
    window._tradeFocus = { other, get };
    render();
  });
  const tradeWith = $('#tradeWith'), pickers = $('#tradePickers');
  if (tradeWith && window._tradeFocus) {
    const tf = window._tradeFocus;
    window._tradeFocus = null;
    tradeWith.value = tf.other;
    setTimeout(() => {
      tradeWith.onchange();
      const cb = pickers.querySelector(`[data-trside="theirs"][value="${tf.get}"]`);
      if (cb) cb.checked = true;
    }, 0);
  }
  if (tradeWith) {
    tradeWith.onchange = () => {
      const other = +tradeWith.value;
      if (!other) { pickers.innerHTML = ''; return; }
      const cur = currentGwIndex();
      const mine = squadAt(mid, cur).sort((a, b) => POS_ORDER[a.pos] - POS_ORDER[b.pos]);
      const theirs = squadAt(other, cur).sort((a, b) => POS_ORDER[a.pos] - POS_ORDER[b.pos]);
      const col = (title, list, side) => `<div style="flex:1;min-width:190px">
        <p style="font-size:12px;font-weight:700;margin-bottom:4px">${title}</p>
        <div style="max-height:220px;overflow-y:auto;border:1px solid var(--line);border-radius:8px;padding:6px">
        ${list.map(p => `<label style="display:flex;gap:6px;align-items:center;font-size:12px;padding:2px 0;cursor:pointer">
          <input type="checkbox" data-trside="${side}" value="${p.id}"><span class="pos-badge pos-${p.pos}">${p.pos}</span> ${esc(p.name)} <span class="muted">${esc(p.club)}</span>
        </label>`).join('')}
        </div></div>`;
      pickers.innerHTML = `
        <p class="muted" style="font-size:11.5px;margin-bottom:6px">Tick any number of players — the same count on each side (2-for-2, 3-for-3…).</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">
          ${col(`${esc(managerName(mid))} gives`, mine, 'mine')}
          ${col(`${esc(managerName(other))} gives`, theirs, 'theirs')}
        </div>
        <input type="text" id="tradeTerms" maxlength="200" placeholder="Side terms (optional) — loan-backs, first refusals, the nonsense…" style="width:100%;margin-bottom:8px">
        <button class="btn small" id="tradeGo">Propose trade</button>`;
      const tradeGo = pickers.querySelector('#tradeGo');
      if (!tradeGo) return;
      tradeGo.onclick = () => {
        if (!actGuard(mid, 'trade')) return;
        const give = [...pickers.querySelectorAll('[data-trside="mine"]:checked')].map(x => +x.value);
        const get = [...pickers.querySelectorAll('[data-trside="theirs"]:checked')].map(x => +x.value);
        if (!give.length || !get.length) { toast('Pick at least one player on each side'); return; }
        if (give.length !== get.length) { toast(`Same number each way — you've ticked ${give.length} for ${get.length}`); return; }
        const giveSet = new Set(give), getSet = new Set(get);
        const meAfter = [...squadAt(mid, cur).filter(p => !giveSet.has(p.id)), ...get.map(pid => PLAYER_BY_ID[pid])];
        const themAfter = [...squadAt(other, cur).filter(p => !getSet.has(p.id)), ...give.map(pid => PLAYER_BY_ID[pid])];
        if (!squadShapeOk(meAfter) || !squadShapeOk(themAfter)) { toast('That combination breaks a squad’s position limits'); return; }
        proposeTrade(mid, other, give, get, $('#tradeTerms').value.trim());
      };
    };
  }
}

/* ---------------- dashboard ---------------- */
function viewDash() {
  const mid = (whoami && whoami !== -1) ? whoami : state.managers[0].id;
  const cur = currentGwIndex();
  const pair = pairingsFor(cur).find(pr => pr.includes(mid));
  const opp = pair ? (pair[0] === mid ? pair[1] : pair[0]) : null;
  const started = gwHasStarted(cur);
  const my = started ? gwManagerPoints(mid, cur) : projectedGwScore(mid, cur);
  const their = opp ? (started ? gwManagerPoints(opp, cur) : projectedGwScore(opp, cur)) : 0;
  const pct = pair ? Math.round(liveWinProb(pair[0], pair[1], cur) * 100) : null;
  const flags = squadAt(mid, cur).filter(p => p.status && p.status !== 'a');
  const offersIn = toArr(state.trades).filter(t => t.status === 'pending' && t.to === mid);
  const myCl = myClaims(mid);
  const news = [...state.transfers].slice(-5).reverse();
  const covs = [...toArr(state.covenants)].slice(-2).reverse();
  const table = h2hStandings(true);
  const myPos = table.findIndex(r => r.id === mid) + 1;
  const deadline = new Date(gwFrom(cur));
  return `
  <div class="settings-grid">
    <div class="card">
      <h2>GW${GAMEWEEKS[cur].n} — your matchup</h2>
      ${pair ? `
      <div class="h2h-fx" data-mu="${pair[0]}:${pair[1]}:${cur}" style="cursor:pointer;font-size:15px">
        <span style="flex:1;text-align:right"><b>${esc(teamName(pair[0]))}</b></span>
        <span class="fx-score">${started ? gwManagerPoints(pair[0], cur) : projectedGwScore(pair[0], cur)} &ndash; ${started ? gwManagerPoints(pair[1], cur) : projectedGwScore(pair[1], cur)}</span>
        <span style="flex:1"><b>${esc(teamName(pair[1]))}</b></span>
      </div>
      <div class="venue-line">at ${esc(stadium(pair[0]))} &middot; ${gwStatus(cur) === 'final' ? 'full time' : `${started ? 'in play' : 'projected'} &middot; you're ${(mid === pair[0] ? pct : 100 - pct) >= 50 ? '' : 'only '}${mid === pair[0] ? pct : 100 - pct}% to win it`}</div>
      <div class="preview-note chant">${esc(chantFor(pair[0], pair[1], cur))}</div>` : '<p class="muted">No fixture this week — playoffs or the off-season.</p>'}
      <p class="muted" style="font-size:12px;margin-top:10px">${started ? 'Lineups are locked.' : `Lineup locks ${deadline.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.`} You sit <b style="color:var(--text)">${myPos}${['th','st','nd','rd'][((myPos%100>10&&myPos%100<14)?0:Math.min(myPos%10,4))] || 'th'}</b>.</p>
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
        <button class="btn small" data-goto="team">Set my lineup</button>
        <button class="btn ghost small" data-goto="transfers">Transfers</button>
        <button class="btn ghost small" data-goto="h2h">Matches</button>
      </div>
    </div>
    <div class="card">
      <h2>Needs your attention</h2>
      ${flags.length ? `<h3>Squad flags</h3>${flags.map(p => `<div class="lrow" style="font-size:12.5px">${statusChip(p)} ${pname(p)} <span class="muted" style="font-size:11px">${esc(p.news || 'unavailable')}</span></div>`).join('')}` : '<p class="muted" style="font-size:12.5px">Squad fully fit. Enjoy it while it lasts.</p>'}
      ${offersIn.length ? `<h3 style="margin-top:12px">Trade offers in</h3>${offersIn.map(t => `<div class="lrow" style="font-size:12.5px"><b>${esc(managerName(t.from))}</b> offers <b>${esc(tradeNames(tGive(t)))}</b> for ${esc(tradeNames(tGet(t)))}</div>`).join('')}<button class="btn small" data-goto="transfers" style="margin-top:6px">Respond</button>` : ''}
      <h3 style="margin-top:12px">Waivers</h3>
      <p class="muted" style="font-size:12.5px">${myCl.length ? `${myCl.length} claim${myCl.length > 1 ? 's' : ''} lodged.` : 'No claims lodged.'} ${waiverControl() === 'auto' ? `Next run: ${nextWaiverRun(Math.max(lastWaiverRun(), Date.now())).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC.` : waiverControl() === 'open' ? 'The Trough is thrown open.' : 'The Trough is closed.'}</p>
    </div>
    <div class="card">
      <h2>Around the league</h2>
      ${news.length ? news.map(t => `<div class="lrow" style="font-size:12.5px"><span class="tag">${t.trade ? 'trade' : t.waiver ? 'waiver' : t.windowDraft ? 'window' : 'trough'}</span> <b>${esc(teamName(t.managerId))}</b> ${pname(PLAYER_BY_ID[t.outId])} <span class="muted">→</span> <b>${pname(PLAYER_BY_ID[t.inId])}</b></div>`).join('') : '<p class="muted" style="font-size:12.5px">No moves yet.</p>'}
      ${covs.length ? `<h3 style="margin-top:12px">Latest covenants</h3>${covs.map(c => `<div class="lrow" style="font-size:12px">&#128220; <b>${esc(managerName(c.from))}</b> &harr; <b>${esc(managerName(c.to))}</b>: ${esc(c.text)}</div>`).join('')}` : ''}
      <h3 style="margin-top:12px">The table</h3>
      ${table.slice(0, 4).map((r, i) => `<div class="lrow" style="font-size:12.5px"><span class="muted">${i + 1}</span> <b>${esc(r.team || r.name)}</b><span style="margin-left:auto" class="gold">${r.pts}</span></div>`).join('')}
      ${myPos > 4 ? `<div class="lrow" style="font-size:12.5px;border-top:1px dashed var(--line)"><span class="muted">${myPos}</span> <b>${esc(teamName(mid))}</b><span style="margin-left:auto" class="gold">${table[myPos - 1].pts}</span></div>` : ''}
    </div>
  </div>
  ${vidiCard(true)}
  ${awardsCard()}
  ${lobusCard()}
  ${treatmentRoomCard()}`;
}
/* ----- the Treatment Room: league-wide injury desk + fixture quirks -----
   Injury lines ride the official FPL feed (Premier Injuries / Ben Dinnery data);
   blank & double gameweeks are computed from the fixture list, Crellin-style. */
let trmShowAll = false;
function treatmentRoomCard() {
  const ownedBy = {};
  for (const m of state.managers) for (const p of managerSquad(m.id)) ownedBy[p.id] = m.id;
  // owned players: every flag matters; free agents: injuries/doubts/bans only (skip loanees)
  const flagged = PLAYERS.filter(p => p.status !== 'a' && (ownedBy[p.id] != null || 'ids'.includes(p.status)))
    .sort((a, b) => ((ownedBy[b.id] != null) - (ownedBy[a.id] != null)) || (b.newsAdded || '').localeCompare(a.newsAdded || ''));
  const shown = trmShowAll ? flagged : flagged.slice(0, 10);
  const when = p => p.newsAdded ? ` <span style="opacity:.6">(${new Date(p.newsAdded).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })})</span>` : '';
  const rows = shown.map(p => `<div class="lrow" style="font-size:12.5px;flex-wrap:wrap">
      ${statusChip(p)} ${pname(p)} <span class="muted" style="font-size:11px">${esc(p.club)}</span>
      ${ownedBy[p.id] != null ? `<span class="tag">${esc(teamName(ownedBy[p.id]))}</span>` : '<span class="muted" style="font-size:10.5px">free agent</span>'}
      <span class="muted" style="font-size:11px;margin-left:auto;text-align:right">${esc(p.news || 'No update')}${p.chance != null && p.chance > 0 && p.chance < 100 ? ` · <b style="color:var(--text)">${p.chance}%</b>` : ''}${when(p)}</span>
    </div>`).join('');
  // fixture desk: blank & double gameweeks still to come
  const byGw = {};
  for (const f of (state.fixtures || [])) if (f.gw) (byGw[f.gw] = byGw[f.gw] || []).push(f);
  const curN = GAMEWEEKS[currentGwIndex()].n;
  const clubs = TEAMS.map(t => t.name);
  const short = name => TEAMS.find(t => t.name === name)?.short || name;
  const quirks = [];
  for (const [gwN, fx] of Object.entries(byGw)) {
    if (+gwN < curN) continue;
    const count = {};
    for (const f of fx) { count[f.home] = (count[f.home] || 0) + 1; count[f.away] = (count[f.away] || 0) + 1; }
    const dgw = clubs.filter(c => (count[c] || 0) > 1);
    const bgw = fx.length >= 5 ? clubs.filter(c => !count[c]) : []; // <5 fixtures = unscheduled data, not a BGW
    if (dgw.length || bgw.length) quirks.push({ n: +gwN, dgw, bgw });
  }
  quirks.sort((a, b) => a.n - b.n);
  return `<div class="card" style="margin-top:14px">
    <h2>The Treatment Room <span class="muted" style="font-weight:400;font-size:12px">who's crocked, league-wide</span></h2>
    ${rows || '<p class="muted" style="font-size:12.5px">A clean bill of health across the league. Suspicious.</p>'}
    ${flagged.length > 10 ? `<button class="btn ghost small" id="trmMore" style="margin-top:8px">${trmShowAll ? 'Show fewer' : `Show all ${flagged.length}`}</button>` : ''}
    <h3 style="margin-top:14px">Fixture desk <span class="muted" style="font-weight:400;font-size:11px">blanks &amp; doubles ahead</span></h3>
    ${quirks.length ? quirks.slice(0, 4).map(q => `<div class="lrow" style="font-size:12.5px;flex-wrap:wrap"><span class="tag">GW${q.n}</span>
      ${q.dgw.length ? `<span>DOUBLE: <b>${q.dgw.map(short).join(', ')}</b></span>` : ''}
      ${q.bgw.length ? `<span class="muted">BLANK: ${q.bgw.map(short).join(', ')}</span>` : ''}</div>`).join('')
      : '<p class="muted" style="font-size:12.5px">No blank or double gameweeks on the horizon.</p>'}
    <p class="muted" style="font-size:10.5px;margin-top:8px">Injury lines from the official FPL feed (Premier Injuries data), refreshed every 15 minutes. Deep cuts: <a href="https://x.com/BenDinnery" target="_blank" rel="noopener" style="color:var(--accent)">@BenDinnery</a> · <a href="https://x.com/BenCrellin" target="_blank" rel="noopener" style="color:var(--accent)">@BenCrellin</a>.</p>
  </div>`;
}
/* ----- points grid: every score, every week — Draft Fantasy's Points tab ----- */
function pointsGridCard(standings) {
  const gws = [];
  for (let i = 0; i < GAMEWEEKS.length; i++) if (gwStatus(i) === 'final' || gwStatus(i) === 'live') gws.push(i);
  if (!gws.length) return '';
  const scores = {};
  for (const r of standings) scores[r.id] = gws.map(i => gwManagerPoints(r.id, i));
  const hi = gws.map((_, k) => Math.max(...standings.map(r => scores[r.id][k])));
  return `<div class="card" style="margin-bottom:18px">
    <h2>Points, week by week <span class="muted" style="font-weight:400;font-size:12px">gold = top score of the week</span></h2>
    <div style="overflow-x:auto">
    <table class="pool-table" style="font-size:12px">
      <thead><tr><th>Team</th>${gws.map(i => `<th class="num" title="${esc(GAMEWEEKS[i].label)}${gwStatus(i) === 'live' ? ' — in play' : ''}">${GAMEWEEKS[i].n}${gwStatus(i) === 'live' ? '&#8226;' : ''}</th>`).join('')}<th class="num">Total</th></tr></thead>
      <tbody>${standings.map(r => `<tr>
        <td style="white-space:nowrap"><b>${esc(r.team || r.name)}</b></td>
        ${gws.map((i, k) => `<td class="num ${scores[r.id][k] === hi[k] && hi[k] > 0 ? 'gold' : 'muted'}">${scores[r.id][k]}</td>`).join('')}
        <td class="num" style="font-weight:700">${scores[r.id].reduce((t, x) => t + x, 0)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>`;
}
/* ----- the Crystal Ball: luck, playoff odds, points left on bench ----- */
function crystalBallCard(standings) {
  const { rows: ap, played } = allPlayTable();
  if (!played) return '';
  const odds = playoffOdds();
  const rows = standings.map(r => {
    const a = ap[r.id];
    // expected H2H points if you'd played everyone: (3W + D) scaled to one game a week
    const expPts = (3 * a.w + a.d) / 11;
    const luck = r.pts - expPts;
    return { id: r.id, team: r.team || r.name, a, luck, waste: seasonBenchWaste(r.id), odds: odds?.[r.id] };
  });
  const luckiest = [...rows].sort((x, y) => y.luck - x.luck)[0];
  const wasteful = [...rows].sort((x, y) => y.waste - x.waste)[0];
  return `<div class="card" style="margin-bottom:18px">
    <h2>The Crystal Ball <span class="muted" style="font-weight:400;font-size:12px">luck, waste and destiny — the arguments, quantified</span></h2>
    <div style="overflow-x:auto">
    <table class="pool-table">
      <thead><tr><th>Team</th>
        <th class="num" title="Your record if you'd played all eleven others every week">All-play</th>
        <th class="num" title="H2H points vs what your scores deserved. Positive = riding your luck">Luck</th>
        <th class="num" title="Points left on the bench vs your best possible XI, season total">Bench waste</th>
        ${odds ? '<th class="num" title="Monte Carlo simulation of the remaining fixtures, 1,000 runs">Playoffs %</th>' : ''}
      </tr></thead>
      <tbody>
      ${rows.map(r => `<tr>
        <td><b>${esc(r.team)}</b>${r.id === luckiest.id && r.luck > 1 ? ' <span title="Luckiest team in the league">&#127808;</span>' : ''}${r.id === wasteful.id && r.waste > 0 ? ' <span title="Most points left rotting on the bench">&#129681;</span>' : ''}</td>
        <td class="num muted">${r.a.w}-${r.a.d}-${r.a.l}</td>
        <td class="num" style="color:${r.luck > 0.5 ? '#3fb96d' : r.luck < -0.5 ? '#e05555' : 'var(--muted)'}">${r.luck > 0 ? '+' : ''}${r.luck.toFixed(1)}</td>
        <td class="num muted">${r.waste}</td>
        ${odds ? `<td class="num gold">${r.odds}%</td>` : ''}
      </tr>`).join('')}
      </tbody>
    </table></div>
    <p class="muted" style="font-size:10.5px;margin-top:6px">All-play: your record playing every manager every finished week. Luck: actual H2H points minus what that record deserved. ${odds ? 'Playoff odds: 1,000 simulated seasons from everyone’s scoring so far.' : 'Playoff odds appear after three finished gameweeks.'}</p>
  </div>`;
}
/* ----- the week's awards, auto-issued ----- */
// the week's honours, computed once — feeds the awards card AND the Minutes
function lastFinalGw() {
  let last = -1;
  for (let i = 0; i < REGULAR_GWS; i++) if (gwStatus(i) === 'final') last = i;
  return last;
}
function weeklyAwards(last) {
  const scores = state.managers.map(m => ({ id: m.id, s: gwManagerPoints(m.id, last), waste: benchWaste(m.id, last) }));
  const hi = [...scores].sort((a, b) => b.s - a.s)[0];
  const lo = [...scores].sort((a, b) => a.s - b.s)[0];
  const results = pairingsFor(last).map(([a, b]) => {
    const sa = gwManagerPoints(a, last), sb = gwManagerPoints(b, last);
    return sa === sb ? null : { w: sa > sb ? a : b, l: sa > sb ? b : a, ws: Math.max(sa, sb), ls: Math.min(sa, sb), margin: Math.abs(sa - sb) };
  }).filter(Boolean);
  const jammy = [...results].sort((a, b) => a.ws - b.ws)[0];
  const robbed = [...results].sort((a, b) => b.ls - a.ls)[0];
  const hiding = [...results].sort((a, b) => b.margin - a.margin)[0];
  const bench = [...scores].sort((a, b) => b.waste - a.waste)[0];
  // Marc's awards (ledger #2, #3) — judged over every player who took the pitch
  const ev = gwEvent(last)?.playerStats || {};
  const ownerAt = pid => state.managers.find(m => squadAt(m.id, last).some(p => p.id === pid));
  let handful = null, nffb = null;
  for (const [pid, s] of Object.entries(ev)) {
    const p = PLAYER_BY_ID[pid];
    if (!p) continue;
    if (p.pos === 'FW') {
      // goals + cards + penalty involvement, combined. The science is settled.
      const sc = (s.g || 0) + (s.yc || 0) + (s.rc || 0) + (s.pm || 0);
      if (sc >= 2 && (!handful || sc > handful.sc)) handful = { p, s, sc };
    }
    if (p.pos === 'DF' && (s.min || 0) >= 90 && !s.g && !s.a && !s.cs) {
      // the full 90, nothing to declare — most minutes wins, which is all of them
      if (!nffb || (s.min || 0) > (nffb.s.min || 0) || ((s.min || 0) === (nffb.s.min || 0) && p.name < nffb.p.name)) nffb = { p, s };
    }
  }
  const handfulBits = h => [h.s.g ? `${h.s.g} goal${h.s.g > 1 ? 's' : ''}` : '', h.s.yc ? `${h.s.yc} yellow${h.s.yc > 1 ? 's' : ''}` : '', h.s.rc ? 'a red' : '', h.s.pm ? 'a missed pen' : ''].filter(Boolean).join(', ');
  return { hi, lo, jammy, robbed, hiding, bench, handful, nffb, handfulBits, ownerAt };
}
function awardsCard() {
  const last = lastFinalGw();
  if (last < 0) return '';
  const { hi, lo, jammy, robbed, hiding, bench, handful, nffb, handfulBits, ownerAt } = weeklyAwards(last);
  const ownTag = pid => { const o = ownerAt(+pid); return o ? ` <span class="muted">(${esc(teamName(o.id))})</span>` : ' <span class="muted">(the Trough)</span>'; };
  const row = (icon, label, text) => `<div class="lrow" style="font-size:12.5px"><span style="width:22px">${icon}</span><b style="min-width:150px">${label}</b><span>${text}</span></div>`;
  return `<div class="card" style="margin-top:14px">
    <h2>GW${GAMEWEEKS[last].n} — The Committee's Awards <span class="muted" style="font-weight:400;font-size:12px">issued automatically, disputed endlessly</span>
      <button class="btn ghost small" id="copyMinutes" style="margin-left:auto" title="WhatsApp-ready gameweek recap">&#128203; Copy the Minutes</button></h2>
    ${row('&#127942;', 'Manager of the Week', `<b>${esc(teamName(hi.id))}</b> — ${hi.s} points`)}
    ${row('&#129348;', 'The Wooden Spoon', `<b>${esc(teamName(lo.id))}</b> — ${lo.s} points`)}
    ${jammy ? row('&#127808;', 'Jammiest Win', `<b>${esc(teamName(jammy.w))}</b> won with just ${jammy.ws}`) : ''}
    ${robbed ? row('&#128148;', 'Robbed', `<b>${esc(teamName(robbed.l))}</b> scored ${robbed.ls} and still lost`) : ''}
    ${hiding ? row('&#128296;', 'Biggest Hiding', `<b>${esc(teamName(hiding.w))}</b> ${hiding.ws}–${hiding.ls} <b>${esc(teamName(hiding.l))}</b>`) : ''}
    ${bench.waste > 0 ? row('&#129681;', 'Bench of the Week', `<b>${esc(teamName(bench.id))}</b> left ${bench.waste} point${bench.waste === 1 ? '' : 's'} rotting on the bench`) : ''}
    ${handful ? row('&#128058;', '&ldquo;He&rsquo;s A Handful&trade;&rdquo;', `<b>${pname(handful.p)}</b> — ${handfulBits(handful)}${ownTag(handful.p.id)}`) : ''}
    ${nffb ? row('&#129462;', 'No-Footed Full Back', `<b>${pname(nffb.p)}</b> — the full 90, no goal, no assist, no clean sheet. Presented by the Punditry Desk${ownTag(nffb.p.id)}`) : ''}
  </div>`;
}
/* ----- the Lobus Registry (ledger #1 — one mandatory Lobus each) ----- */
function lobusCard() {
  if (state.phase !== 'season') return '';
  const declared = state.managers.filter(m => state.lobus?.[m.id]);
  const waiting = state.managers.filter(m => !state.lobus?.[m.id]);
  const bonus = +state.settings.lobusBonus || 0;
  const rows = declared.map(m => {
    const p = PLAYER_BY_ID[state.lobus[m.id]];
    if (!p) return '';
    const hon = lobusHonours(m.id);
    return `<div class="lrow" style="font-size:12.5px">${photoImg(p)} <b>${pname(p)}</b> <span class="muted" style="font-size:11px">${esc(p.club)}</span>
      <span class="tag">${esc(teamName(m.id))}</span>
      <span class="muted" style="margin-left:auto;font-size:11.5px">${hon ? `honoured his people &times;${hon}` : 'yet to honour his people'}</span></div>`;
  }).join('');
  return `<div class="card" style="margin-top:14px">
    <h2>The Lobus Registry <span class="muted" style="font-weight:400;font-size:12px">one each, mandatory, sponsored by Ali Daei (108 international goals, the original)</span></h2>
    ${rows || '<p class="muted" style="font-size:12.5px">No Lobus has been declared. The Committee is patient, but the klaxon is charged.</p>'}
    ${waiting.length && declared.length ? `<p class="muted" style="font-size:11.5px;margin-top:8px">Yet to declare: ${waiting.map(m => esc(managerName(m.id))).join(', ')}. The Committee waits.</p>` : ''}
    <p class="muted" style="font-size:10.5px;margin-top:6px">Declare from any of your players' cards — open, declare, regret. Changeable until GW1 kicks off.${bonus ? ` Lobus bonus: <b style="color:var(--text)">+${bonus}</b> any week your starting Lobus scores or assists.` : ' Bonus points: pending Committee approval (Settings).'}</p>
  </div>`;
}
/* ----- the Committee Minutes: one tap, WhatsApp-ready recap ----- */
function committeeMinutes(last) {
  const g = GAMEWEEKS[last];
  const { hi, lo, jammy, robbed, hiding, bench, handful, nffb, handfulBits } = weeklyAwards(last);
  const L = [`\u{1F3C6} THE LEAGUE — GW${g.n} COMMITTEE MINUTES`, '', '*Results*'];
  for (const [a, b] of pairingsFor(last)) {
    const sa = gwManagerPoints(a, last), sb = gwManagerPoints(b, last);
    const na = sa > sb ? `*${teamName(a)}*` : teamName(a);
    const nb = sb > sa ? `*${teamName(b)}*` : teamName(b);
    L.push(`${na} ${sa}–${sb} ${nb}`);
  }
  L.push('', "*The Committee's Awards*");
  L.push(`\u{1F3C6} Manager of the Week: ${teamName(hi.id)} (${hi.s})`);
  L.push(`\u{1F944} Wooden Spoon: ${teamName(lo.id)} (${lo.s})`);
  if (jammy) L.push(`\u{1F340} Jammiest Win: ${teamName(jammy.w)} won with just ${jammy.ws}`);
  if (robbed) L.push(`\u{1F494} Robbed: ${teamName(robbed.l)} scored ${robbed.ls} and still lost`);
  if (hiding) L.push(`\u{1F528} Biggest Hiding: ${teamName(hiding.w)} ${hiding.ws}–${hiding.ls} ${teamName(hiding.l)}`);
  if (bench.waste > 0) L.push(`\u{1FAD1} Bench of the Week: ${teamName(bench.id)} left ${bench.waste} on the bench`);
  if (handful) L.push(`\u{1F43A} "He's A Handful™": ${handful.p.name} — ${handfulBits(handful)}`);
  if (nffb) L.push(`\u{1F9B5} No-Footed Full Back: ${nffb.p.name} — the full 90, nothing to declare`);
  const t = h2hStandings(false);
  L.push('', '*The Table*');
  t.slice(0, 4).forEach((r, i) => L.push(`${i + 1}. ${r.team || r.name} — ${r.pts}`));
  const bottom = t[t.length - 1];
  L.push('…', `${t.length}. ${bottom.team || bottom.name} — ${bottom.pts} \u{1F96B}`);
  L.push('', 'Minutes recorded automatically. Disputes to the group chat, where they will be enjoyed.');
  L.push('https://benmpolak.github.io/the-league/');
  return L.join('\n');
}
function bindDash() {
  document.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => { state.view = b.dataset.goto; save(); render(); });
  const cm = $('#copyMinutes');
  if (cm) cm.onclick = () => {
    const last = lastFinalGw();
    if (last < 0) return;
    const txt = committeeMinutes(last);
    (navigator.clipboard?.writeText(txt) || Promise.reject()).then(
      () => toast('Minutes copied — paste straight into the chat'),
      () => { window.prompt('Copy the Minutes:', txt); });
  };
  const tm = $('#trmMore');
  if (tm) tm.onclick = () => { trmShowAll = !trmShowAll; render(); };
  document.querySelectorAll('[data-mu]').forEach(el => el.onclick = () => {
    const [a, b, i] = el.dataset.mu.split(':').map(Number);
    showMatchup(a, b, i);
  });
}

/* ----- playoffs (GW34 semis, GW35–36 two-legged final) ----- */
function playoffState() {
  for (let i = 0; i < REGULAR_GWS; i++) if (gwStatus(i) !== 'final') return null;
  const seeds = standingsBefore(REGULAR_GWS).rows.map(r => r.id).slice(0, 4);
  const semiIdx = REGULAR_GWS; // GW34
  const semis = [[seeds[0], seeds[3]], [seeds[1], seeds[2]]];
  const semiDone = gwStatus(semiIdx) === 'final';
  const higherSeed = (a, b) => seeds.indexOf(a) < seeds.indexOf(b) ? a : b;
  const semiWinners = semiDone ? semis.map(([a, b]) => {
    const pa = gwManagerPoints(a, semiIdx), pb = gwManagerPoints(b, semiIdx);
    return pa === pb ? higherSeed(a, b) : (pa > pb ? a : b);
  }) : null;
  let champion = null;
  if (semiWinners && gwStatus(REGULAR_GWS + 2) === 'final') {
    const [x, y] = semiWinners;
    let wx = 0, wy = 0, cx = 0, cy = 0;
    for (const i of [REGULAR_GWS + 1, REGULAR_GWS + 2]) {
      const px = gwManagerPoints(x, i), py = gwManagerPoints(y, i);
      cx += px; cy += py;
      if (px > py) wx++; else if (py > px) wy++;
    }
    champion = wx > wy ? x : wy > wx ? y
      : cx > cy ? x : cy > cx ? y : higherSeed(x, y);
  }
  return { seeds, semis, semiIdx, semiWinners, champion };
}
function playoffCard() {
  const po = playoffState();
  if (!po) {
    return `<div class="card" style="margin-bottom:18px"><h2>The Playoffs</h2>
      <p class="muted" style="font-size:12.5px">GW33 ends the regular season. Top four go through: GW34 semi-finals (1st v 4th, 2nd v 3rd, one leg), GW35–36 the two-legged final. Ties: cumulative points, then regular-season position.</p></div>`;
  }
  const semiScore = (a, b) => `${gwManagerPoints(a, po.semiIdx)} – ${gwManagerPoints(b, po.semiIdx)}`;
  return `<div class="card" style="margin-bottom:18px"><h2>The Playoffs</h2>
    ${po.semis.map(([a, b], k) => `<div class="h2h-fx">
      <span style="flex:1;text-align:right">${k === 0 ? '1st' : '2nd'} ${esc(teamName(a))}</span>
      <span class="fx-score">${gwStatus(po.semiIdx) === 'upcoming' ? 'GW34' : semiScore(a, b)}</span>
      <span style="flex:1">${esc(teamName(b))} ${k === 0 ? '4th' : '3rd'}</span></div>`).join('')}
    ${po.semiWinners ? `<div class="h2h-fx"><span style="flex:1;text-align:right">${esc(teamName(po.semiWinners[0]))}</span>
      <span class="fx-score">FINAL · GW35–36</span>
      <span style="flex:1">${esc(teamName(po.semiWinners[1]))}</span></div>` : ''}
    ${po.champion ? `<p style="text-align:center;font-size:16px;margin-top:10px">&#127942; <b>${esc(teamName(po.champion))}</b> — champions of The League 2026/27</p>` : ''}
  </div>`;
}

/* ----- head-to-head ----- */
/* ----- fixture matchup: side-by-side pitches, Draft Fantasy style ----- */
let muView = 'pitch';
function showMatchup(a, b, i) {
  const reopening = !!$('#muOverlay'); // pitch/table toggle re-renders in place
  $('#muOverlay')?.remove();
  const started = gwStatus(i) !== 'upcoming';
  const effInfo = {};
  for (const mid of [a, b]) effInfo[mid] = started ? effectiveXI(mid, i) : { xi: lineupFor(mid, i), subs: [] };
  const xiOf = mid => effInfo[mid].xi;
  const chip = (pid, mid) => {
    const p = PLAYER_BY_ID[pid];
    const pts = started ? gwPlayerPoints(pid, i) : null;
    const cameOn = effInfo[mid].subs.some(s => s.in === pid);
    return `<div class="pitch-chip mu-chip ${statusClass(p)}" data-pcard="${p.id}">
      ${cameOn ? '<span class="sub-arrow in" title="Auto-sub — came on">&#9650;</span>' : ''}
      ${kitImg(p.team, p.pos === 'GK')}
      <span class="pitch-name">${esc(p.name)}</span>
      ${pts != null ? `<span class="mu-pts">${pts}</span>` : `<span class="pitch-vs">${nextOppHtml(p.team, GAMEWEEKS[i].n)}</span>`}
    </div>`;
  };
  // the bench: unused subs in priority order, then anyone auto-subbed OUT
  const benchOf = mid => {
    const xi = new Set(xiOf(mid));
    const outs = new Set(effInfo[mid].subs.map(s => s.out));
    return [...benchFor(mid, i).filter(p => !xi.has(p.id)), ...squadAt(mid, i).filter(p => outs.has(p.id))];
  };
  const sideBench = mid => {
    const outs = new Set(effInfo[mid].subs.map(s => s.out));
    const bench = benchOf(mid);
    if (!bench.length) return '';
    return `<div class="bench-strip mu-bench">
      <span class="muted" style="font-size:10px;font-weight:700;align-self:center">BENCH</span>
      ${bench.map(p => `<div class="pitch-chip mu-chip benched ${statusClass(p)}" data-pcard="${p.id}">
        ${outs.has(p.id) ? '<span class="sub-arrow out" title="Auto-subbed out — did not play">&#9660;</span>' : ''}
        ${kitImg(p.team, p.pos === 'GK')}
        <span class="pitch-name">${esc(p.name)}</span>
        ${started ? `<span class="mu-pts">${gwPlayerPoints(p.id, i)}</span>` : ''}
      </div>`).join('')}
    </div>`;
  };
  const sidePitch = mid => `<div class="pitch mu-pitch">
    ${['GK', 'DF', 'MF', 'FW'].map(pos =>
      `<div class="pitch-row">${xiOf(mid).map(pid => PLAYER_BY_ID[pid]).filter(p => p.pos === pos).map(p => chip(p.id, mid)).join('')}</div>`).join('')}
  </div>${sideBench(mid)}`;
  const sideTable = mid => `<div>${xiOf(mid).map(pid => PLAYER_BY_ID[pid])
    .sort((x, y) => POS_ORDER[x.pos] - POS_ORDER[y.pos])
    .map(p => `<div class="lrow" style="font-size:12px"><span class="pos-badge pos-${p.pos}">${p.pos}</span>${pname(p)}<span class="sp-pts ${started && gwPlayerPoints(p.id, i) > 0 ? 'gold' : 'muted'}" style="margin-left:auto">${started ? gwPlayerPoints(p.id, i) : playerXp(p).toFixed(1)}</span></div>`).join('')}
    ${benchOf(mid).map(p => `<div class="lrow" style="font-size:11.5px;opacity:.65"><span class="pos-badge pos-${p.pos}">${p.pos}</span>${pname(p)}<span class="xi-chip">bench</span><span class="sp-pts muted" style="margin-left:auto">${started ? gwPlayerPoints(p.id, i) : ''}</span></div>`).join('')}</div>`;
  const side = mid => `<div class="mu-side">
    <h3 style="text-align:center">${esc(teamName(mid))} <b class="gold">${started ? gwManagerPoints(mid, i) : projectedGwScore(mid, i)}</b></h3>
    ${muView === 'pitch' ? sidePitch(mid) : sideTable(mid)}
  </div>`;
  const ov = document.createElement('div');
  ov.id = 'muOverlay';
  ov.className = 'overlay';
  ov.innerHTML = `<div class="card mu-card">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
      <div class="pool-controls" style="margin:0">
        <button class="btn small ${muView === 'pitch' ? '' : 'ghost'}" id="muPitch">Pitch</button>
        <button class="btn small ${muView === 'table' ? '' : 'ghost'}" id="muTable">Table</button>
      </div>
      <p class="venue-line" style="flex:1;margin:0">GW${GAMEWEEKS[i].n} &middot; at ${esc(stadium(a))} &middot; Att ${attendance(a, b, i).toLocaleString()} &middot; ${gwStatus(i) === 'final' ? 'full time' : `${started ? 'in play' : 'projected'} &middot; ${Math.round(liveWinProb(a, b, i) * 100)}% – ${100 - Math.round(liveWinProb(a, b, i) * 100)}%`}</p>
      <button class="btn ghost small" id="muClose">&#10005;</button>
    </div>
    ${adStrip(a * 1009 + b * 31 + i, 4)}
    <div class="mu-grid">${side(a)}${side(b)}</div>
    <p class="venue-line" style="margin-top:8px">${esc(chantFor(a, b, i))}</p>
  </div>`;
  ov.onclick = e => { if (e.target === ov || e.target.id === 'muClose') closeOv(ov); };
  ov.querySelector('#muPitch').onclick = e => { e.stopPropagation(); muView = 'pitch'; showMatchup(a, b, i); };
  ov.querySelector('#muTable').onclick = e => { e.stopPropagation(); muView = 'table'; showMatchup(a, b, i); };
  document.body.appendChild(ov);
  if (!reopening) pushOvState(); // phone back button closes the matchup, not the site
}
let h2hView = { gw: null };
function bindH2H() {
  document.querySelectorAll('[data-mu]').forEach(el => el.onclick = () => {
    const [a, b, i] = el.dataset.mu.split(':').map(Number);
    showMatchup(a, b, i);
  });
  const prev = $('#gwPrev'), next = $('#gwNext');
  if (prev) prev.onclick = () => { h2hView.gw = Math.max(0, h2hView.gw - 1); render(); };
  if (next) next.onclick = () => { h2hView.gw = Math.min(REGULAR_GWS - 1, h2hView.gw + 1); render(); };
}

/* ----- the weekly preview ----- */
function lastMeetings(a, b, before) {
  const res = [];
  for (let i = 0; i < before; i++) {
    if (gwStatus(i) !== 'final') continue;
    if (pairingsFor(i).some(([x, y]) => (x === a && y === b) || (x === b && y === a))) {
      res.push({ gw: i, pa: gwManagerPoints(a, i), pb: gwManagerPoints(b, i) });
    }
  }
  return res;
}
// average FPL strength of the clubs a manager's XI faces this gameweek (lower = kinder)
function fixtureEase(mid, gwIdx) {
  const gwN = GAMEWEEKS[gwIdx].n;
  const opps = [];
  for (const pid of lineupFor(mid, gwIdx)) {
    const p = PLAYER_BY_ID[pid];
    for (const f of state.fixtures) {
      if (f.gw !== gwN) continue;
      if (f.home === p.team) opps.push(TEAM_BY_NAME[f.away]?.str);
      else if (f.away === p.team) opps.push(TEAM_BY_NAME[f.home]?.str);
    }
  }
  const vals = opps.filter(Boolean);
  return vals.length ? vals.reduce((t, v) => t + v, 0) / vals.length : null;
}
function rivalryFor(a, b, seed) {
  if (typeof RIVALRIES === 'undefined') return null;
  const hits = RIVALRIES.filter(r => (r.pair[0] === a && r.pair[1] === b) || (r.pair[0] === b && r.pair[1] === a));
  return hits.length ? hits[seed % hits.length].line : null;
}
/* ----- from the terraces (requested by Marc, 03/07/2026, 12:59) ----- */
const CHANTS = [
  '\u{1F3B5} One {star}! There\u2019s only one {star}!',
  '\u{1F3B5} {hmgr}\u2019s barmy army! {hmgr}\u2019s barmy army!',
  '\u{1F3B5} Stand up if you hate {away}!',
  '\u{1F3B5} You\u2019re getting dropped in the mo-o-orning \u2014 dropped in the morning!',
  '\u{1F3B5} 2-1 to the {home}! (Prutton, from the away end)',
  '\u{1F3B5} Que sera sera, whatever will be will be, we\u2019re going to {stadium}, que sera sera',
  '\u{1F3B5} Is this the Emirates? Is this the Emirates?',
  '\u{1F3B5} We forgot that you were here \u2014 we forgot that you were he-ere',
  '\u{1F3B5} Empty seats! Empty seats! (the {stadium} faithful, all four of them)',
  '\u{1F4CB} A banner unfurls at {stadium}: \u201CWELCOME TO HELL\u201D. Stewards confirm it is laminated.',
  '\u{1F3B5} You\u2019ve only got one Lobus \u2014 one Lobus, you\u2019ve only got one Lobus',
  '\u{1F3B5} We want our fifty quid back! We want our fifty quid back!',
  '\u{1F3B5} {amgr}, give us a wave \u2014 {amgr}, {amgr}, give us a wave',
  '\u{1F3B5} Sacked in the morning, you\u2019re getting sacked in the morning ({away} board: no comment)',
  '\u{1F3B5} Shall we sing a song for you? The {stadium} end asks, genuinely, out of concern',
];
function chantFor(a, b, i) {
  const seed = (i * 2654435761 + a * 97 + b * 13) >>> 0;
  const t = CHANTS[seed % CHANTS.length];
  const xi = lineupFor(a, i).map(pid => PLAYER_BY_ID[pid]).sort((x, y) => rating(y) - rating(x));
  return t.replaceAll('{star}', xi[0]?.name || 'the big man')
    .replaceAll('{home}', teamName(a)).replaceAll('{away}', teamName(b))
    .replaceAll('{hmgr}', managerName(a).split(' ')[0]).replaceAll('{amgr}', managerName(b).split(' ')[0])
    .replaceAll('{stadium}', stadium(a));
}

function gwPreviewCard(i) {
  if (i >= REGULAR_GWS || gwStatus(i) === 'final' || !state.draft.picks.length) return '';
  const pairs = pairingsFor(i);
  if (!pairs.length) return '';
  const table = h2hStandings();
  const posOf = Object.fromEntries(table.map((r, k) => [r.id, k + 1]));
  const anyPlayed = table.some(r => r.p > 0);
  const ord = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) === 1 ? 1 : n % 10 === 2 ? 2 : n % 10 === 3 ? 3 : 0]);
  const rows = pairs.map(([a, b]) => {
    const sa = projectedGwScore(a, i), sb = projectedGwScore(b, i);
    return { a, b, sa, sb, p: liveWinProb(a, b, i), riv: rivalryFor(a, b, i) };
  });
  // matchup of the week: a rivalry if one is on, else the tightest projection
  const motw = [...rows].sort((x, y) => (y.riv ? 1 : 0) - (x.riv ? 1 : 0) || Math.abs(x.sa - x.sb) - Math.abs(y.sa - y.sb))[0];
  const notes = r => {
    const out = [];
    if (r.riv) out.push(r.riv);
    const met = lastMeetings(r.a, r.b, i);
    if (met.length) {
      const m = met[met.length - 1];
      out.push(m.pa === m.pb
        ? `Last met GW${GAMEWEEKS[m.gw].n}: a ${m.pa}–${m.pb} draw nobody enjoyed.`
        : `Last met GW${GAMEWEEKS[m.gw].n}: ${teamName(m.pa > m.pb ? r.a : r.b)} won it ${Math.max(m.pa, m.pb)}–${Math.min(m.pa, m.pb)}.`);
    } else if (anyPlayed) out.push('First meeting of the season.');
    if (anyPlayed && out.length < 2) {
      for (const id of [r.a, r.b]) {
        if (posOf[id] >= 10) { out.push(`${teamName(id)} (${ord(posOf[id])}) badly needs the points.`); break; }
        if (posOf[id] === 5) { out.push(`${teamName(id)} sits 5th — right on the playoff line.`); break; }
      }
    }
    if (out.length < 2) {
      const ea = fixtureEase(r.a, i), eb = fixtureEase(r.b, i);
      if (ea && eb && Math.abs(ea - eb) > 40) out.push(`${teamName(ea < eb ? r.a : r.b)}'s players have the kinder club fixtures this week.`);
    }
    if (out.length < 2 && typeof MANAGER_LORE !== 'undefined') {
      for (const id of [r.a, r.b]) if (MANAGER_LORE[id]) { out.push(`${managerName(id)} ${MANAGER_LORE[id]}.`); break; }
    }
    return out.slice(0, 2);
  };
  const recent = state.transfers.filter(t => t.gw === i || t.gw === i - 1).slice(-6);
  const trough = recent.length ? `<p class="muted" style="font-size:12px;margin-top:10px"><b>Trough watch:</b> ${recent.map(t => `${esc(managerName(t.managerId))} ${t.trade ? 'traded for' : 'signed'} ${esc(PLAYER_BY_ID[t.inId]?.name || '?')}`).join(' · ')}</p>` : '';
  return `<div class="card" style="margin-bottom:18px">
    <h2>GW${GAMEWEEKS[i].n} preview <span class="tag">projected scores &amp; win chance</span></h2>
    ${[motw, ...rows.filter(r => r !== motw)].map(r => {
      const pct = Math.round(r.p * 100);
      return `<div class="preview-fx${r === motw ? ' motw' : ''}">
        ${r === motw ? '<div class="motw-tag">&#11088; MATCHUP OF THE WEEK</div>' : ''}
        <div class="h2h-fx" data-mu="${r.a}:${r.b}:${i}" style="cursor:pointer" title="Tap for the matchup">
          <span style="flex:1;text-align:right">${esc(teamName(r.a))} <b class="pct">${pct}%</b></span>
          <span class="fx-score" title="projected score">${r.sa} &ndash; ${r.sb}</span>
          <span style="flex:1"><b class="pct">${100 - pct}%</b> ${esc(teamName(r.b))}</span>
        </div>
        <div class="venue-line">at ${esc(stadium(r.a))}</div>
        ${notes(r).map(n => `<div class="preview-note">${esc(n)}</div>`).join('')}
        <div class="preview-note chant">${esc(chantFor(r.a, r.b, i))}</div>
      </div>`;
    }).join('')}
    ${trough}
    <p class="muted" style="font-size:10.5px;margin-top:8px">Projections built from FPL expected points for each current XI. The Committee accepts no liability.</p>
  </div>`;
}

function viewH2H() {
  const cur = currentGwIndex();
  const liveNow = GAMEWEEKS.slice(0, REGULAR_GWS).some((g, i) => gwStatus(i) === 'live');
  const standings = h2hStandings(liveNow);
  const anyFinal = standings.some(r => r.p > 0);
  let delta = {};
  if (liveNow) {
    const base = h2hStandings(false);
    const basePos = Object.fromEntries(base.map((r, k) => [r.id, k]));
    standings.forEach((r, k) => { delta[r.id] = basePos[r.id] - k; });
  }
  const arrow = id => !liveNow || !delta[id] ? ''
    : delta[id] > 0 ? `<span style="color:#3fb96d;font-size:11px">&#9650;${delta[id]}</span>`
    : `<span style="color:#e05555;font-size:11px">&#9660;${-delta[id]}</span>`;
  return `
  <div class="card" style="margin-bottom:18px">
    <h2>Head-to-Head table ${liveNow ? '<span class="tag live-tag"><span class="rec"></span>LIVE</span>' : ''} <span class="muted" style="font-weight:400;font-size:12px">win 3 &middot; draw 1 &middot; loss 0 &middot; tiebreak: overall points &middot; regular season = GW1–33</span></h2>
    <table class="pool-table">
      <thead><tr><th></th><th>Team</th><th class="num">P</th><th class="num">W</th><th class="num">D</th><th class="num">L</th><th class="num" title="H2H points scored">+</th><th class="num" title="H2H points conceded">&minus;</th><th class="num">Pts</th><th class="num">Overall</th></tr></thead>
      <tbody>
      ${standings.map((r, i) => `
        <tr class="${i === 3 ? 'playoff-line' : ''}">
          <td class="muted">${i + 1}</td>
          <td><b>${esc(r.team || r.name)}</b> <span class="muted" style="font-size:11px">${esc(r.name)}</span> ${arrow(r.id)} ${anyFinal && i === 0 ? '&#127942;' : ''}</td>
          <td class="num">${r.p}</td><td class="num">${r.w}</td><td class="num">${r.d}</td><td class="num">${r.l}</td>
          <td class="num muted">${r.pf}</td><td class="num muted">${r.pa}</td>
          <td class="num gold">${r.pts}</td>
          <td class="num muted">${managerPoints(r.id)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <p class="muted" style="font-size:11px;margin-top:6px">Top four make the playoffs.${liveNow ? ' Live table — includes the gameweek in progress.' : ''}</p>
  </div>
  ${pointsGridCard(standings)}
  ${crystalBallCard(standings)}
  ${gwPreviewCard(cur)}
  ${playoffCard()}
  ${(() => {
    if (h2hView.gw == null) h2hView.gw = Math.min(cur, REGULAR_GWS - 1);
    const i = h2hView.gw, g = GAMEWEEKS[i];
    const st = gwStatus(i);
    const tag = st === 'final' ? '<span class="tag">FT</span>'
      : st === 'live' ? '<span class="tag live-tag"><span class="rec"></span>LIVE</span>'
      : st === 'underway' ? '<span class="tag">underway — tap the lines</span>'
      : '<span class="tag">upcoming</span>';
    return `
    <div class="card" style="margin-bottom:12px">
      <h2 style="display:flex;align-items:center;gap:10px">GW${g.n} Matches ${tag}
        <span style="margin-left:auto;display:flex;gap:6px;align-items:center">
          <button class="btn ghost small" id="gwPrev" ${i === 0 ? 'disabled' : ''}>&#8249; Previous</button>
          <span class="tag">${g.n}</span>
          <button class="btn ghost small" id="gwNext" ${i >= REGULAR_GWS - 1 ? 'disabled' : ''}>Next &#8250;</button>
        </span>
      </h2>
      ${pairingsFor(i).map(([a, b]) => {
        const pa = st === 'upcoming' ? '–' : gwManagerPoints(a, i);
        const pb = st === 'upcoming' ? '–' : gwManagerPoints(b, i);
        const aWin = st === 'final' && pa > pb, bWin = st === 'final' && pb > pa;
        return `<div class="h2h-fx" data-mu="${a}:${b}:${i}" style="cursor:pointer" title="Tap for the matchup">
          <span class="${aWin ? 'h2h-win' : ''}" style="flex:1;text-align:right">${esc(teamName(a))} <span class="muted" style="font-size:10px">(H)</span></span>
          <span class="fx-score">${pa} &ndash; ${pb}</span>
          <span class="${bWin ? 'h2h-win' : ''}" style="flex:1">${esc(teamName(b))}</span>
        </div>
        <div class="venue-line">${esc(stadium(a))}${st === 'live' || st === 'underway' ? (() => {
          const w = Math.round(liveWinProb(a, b, i) * 100);
          const ta = teamOutlook(a, i), tb = teamOutlook(b, i);
          return ` &middot; win chance ${w}% – ${100 - w}% &middot; ${ta.toPlay} v ${tb.toPlay} still to play`;
        })() : ''}</div>`;
      }).join('')}
      <h3 style="margin-top:14px">GW${g.n} — the real fixtures</h3>
      ${(() => {
        const fxs = state.fixtures.filter(f => f.gw === g.n);
        return fxs.map(f => {
          const live = f.started && !f.finished;
          const score = !f.started ? new Date(f.date).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : `${f.hs ?? ''} – ${f.as ?? ''}`;
          return `<div class="h2h-fx" style="font-size:12.5px">
            <span style="flex:1;text-align:right">${esc(f.home)} ${flagImg(f.home)}</span>
            <span class="fx-score" style="font-size:12px">${score}${live ? ` <span class="rec" style="display:inline-block"></span>` : ''}</span>
            <span style="flex:1">${flagImg(f.away)} ${esc(f.away)}</span>
          </div>`;
        }).join('') || '<p class="muted" style="font-size:12px">No fixtures scheduled yet.</p>';
      })()}
    </div>`;
  })()}
  ${vidiCard()}`;
}

/* ----- the Monzo Cup (last man standing, from GW8) ----- */
function viewCup() {
  let alive = state.managers.map(m => m.id);
  const rounds = [];
  for (let i = CUP_START; i < REGULAR_GWS && alive.length > 1; i++) {
    if (gwStatus(i) !== 'final') break;
    const scores = alive.map(id => ({ id, pts: gwManagerPoints(id, i) })).sort((x, y) => y.pts - x.pts);
    const min = scores[scores.length - 1].pts;
    const lowest = scores.filter(s => s.pts === min);
    const out = lowest.length === 1 ? lowest[0].id : null;
    rounds.push({ i, scores, out, tie: lowest.length > 1 });
    if (out) alive = alive.filter(id => id !== out);
  }
  const winner = alive.length === 1 ? alive[0] : null;
  return `
  <div class="card" style="margin-bottom:18px">
    <h2>The Monzo League Cup <span class="tag">last man standing</span></h2>
    <p class="muted" style="font-size:12.5px;margin-bottom:10px">From GW8: the lowest gameweek score among the survivors is eliminated. Ties roll over — nobody goes. Winner takes £75 and eternal glory (£75 of it).</p>
    ${winner ? `<p style="font-size:16px">&#127942; <b>${esc(teamName(winner))}</b> — last man standing.</p>`
      : rounds.length === 0 ? `<p class="muted">The Cup begins GW8. All twelve enter. One leaves per week. It's very simple and very cruel.</p>`
      : `<p style="font-size:13.5px"><b>${alive.length} still standing:</b> ${alive.map(id => esc(teamName(id))).join(' · ')}</p>`}
  </div>
  ${[...rounds].reverse().map(r => `
    <div class="card" style="margin-bottom:12px">
      <h2>GW${GAMEWEEKS[r.i].n} ${r.tie ? '<span class="tag">tie at the bottom — everyone survives</span>' : ''}</h2>
      ${r.scores.map(s => `<div class="lrow" style="justify-content:space-between${s.id === r.out ? ';color:var(--bad,#e66)' : ''}">
        <span>${esc(teamName(s.id))} ${s.id === r.out ? '&#128128; ELIMINATED' : ''}</span><b>${s.pts}</b></div>`).join('')}
    </div>`).join('')}
  ${hamCupCard()}`;
}

/* ----- the Palwin Ham Cup (ledger #6, Tussie) — Trough players only ----- */
let hamView = { q: '', sel: null };
function hamCupCard() {
  if (state.phase !== 'season') return '';
  const hc = state.hamCup;
  const head = `<h2>The Palwin Ham Cup <span class="tag">strictly Trough</span></h2>
    <p class="muted" style="font-size:12.5px;margin-bottom:10px">One random gameweek. Every manager fields an XI drawn ONLY from the unowned — the Trough's finest, like the Milk Cup if the milk had turned. Entirely optional, entirely stupid. Proudly sponsored by Palwin.</p>`;
  if (!hc) {
    return `<div class="card" style="margin-top:18px">${head}
      ${netOn() && !isCommissioner() ? '<p class="muted" style="font-size:12px">The tie has not been drawn. The Chairman holds the velvet bag.</p>'
        : '<button class="btn small" id="hamDraw">&#127829; Draw the Ham Cup tie</button>'}
    </div>`;
  }
  const i = hc.gw, g = GAMEWEEKS[i];
  const st = gwStatus(i);
  const entries = hc.entries || {};
  const entered = state.managers.filter(m => toArr(entries[m.id]).length === 11);
  if (st === 'upcoming') {
    const iAm = whoami && whoami !== -1;
    const owned = ownedIdsAt(currentGwIndex());
    const mySel = hamView.sel ?? toArr(entries[whoami] || []);
    const free = PLAYERS.filter(p => !owned.has(p.id));
    const q = normName(hamView.q);
    const picked = mySel.map(pid => PLAYER_BY_ID[pid]).filter(Boolean);
    const cands = free.filter(p => !mySel.includes(p.id) && (!q || normName(p.name).includes(q) || normName(p.club).includes(q)))
      .sort((a, b) => rating(b) - rating(a)).slice(0, 30);
    const shape = xiValid(mySel);
    const cnt = xiCounts(mySel);
    const prow = (p, on) => `<div class="lrow" style="font-size:12.5px"><label style="display:flex;gap:8px;align-items:center;cursor:pointer;flex:1">
      <input type="checkbox" data-ham="${p.id}" ${on ? 'checked' : ''}> <span class="pos-badge pos-${p.pos}">${p.pos}</span> ${pname(p)}
      <span class="muted" style="font-size:11px">${esc(p.club)}</span><span class="muted" style="margin-left:auto;font-size:11px">${metricsFor(p).pts} pts</span></label></div>`;
    return `<div class="card" style="margin-top:18px">${head}
      <p class="rules-p"><b>The tie is drawn: GW${g.n}.</b> Entries lock at the deadline. ${entered.length}/12 XIs in${entered.length ? ` (${entered.map(m => esc(managerName(m.id))).join(', ')})` : ''}.</p>
      ${iAm ? `
      <h3 style="margin-top:12px">Your Ham XI <span class="tag">${mySel.length}/11</span> <span class="muted" style="font-weight:400;font-size:11px">1 GK &middot; 3–5 DF &middot; 2–5 MF &middot; 1–3 FW &middot; picked: ${cnt.GK} GK ${cnt.DF} DF ${cnt.MF} MF ${cnt.FW} FW</span></h3>
      ${picked.map(p => prow(p, true)).join('') || '<p class="muted" style="font-size:12px">Nobody yet. The Trough awaits.</p>'}
      <input type="text" id="hamQ" placeholder="Search the Trough…" value="${esc(hamView.q)}" style="margin:8px 0;width:100%;box-sizing:border-box">
      ${cands.map(p => prow(p, false)).join('')}
      <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
        <button class="btn small" id="hamSave" ${shape ? '' : 'disabled'}>Enter this XI</button>
        ${!shape && mySel.length === 11 ? '<span class="muted" style="font-size:11.5px">Shape’s illegal — check the position counts.</span>' : ''}
      </div>
      <p class="muted" style="font-size:10.5px;margin-top:8px">If someone signs your ham player before the gameweek, he still counts for your Ham XI. The Committee finds this funny.</p>` : '<p class="muted" style="font-size:12px">Sign in to enter your Ham XI.</p>'}
      ${netOn() && isCommissioner() || !netOn() ? '<button class="btn ghost small" id="hamCancel" style="margin-top:8px">Call the whole thing off</button>' : ''}
    </div>`;
  }
  // underway or done — score it
  const rows = state.managers.map(m => {
    const xi = toArr(entries[m.id]);
    return { id: m.id, entered: xi.length === 11, pts: xi.reduce((t, pid) => t + gwPlayerPoints(pid, i), 0) };
  }).sort((a, b) => (b.entered - a.entered) || b.pts - a.pts);
  const winner = st === 'final' && rows[0]?.entered ? rows[0] : null;
  return `<div class="card" style="margin-top:18px">${head}
    <p class="rules-p"><b>GW${g.n}</b> — ${st === 'final' ? 'full time.' : 'in play. The ham is loose.'}</p>
    ${winner ? `<p style="font-size:15px">&#127829;&#127942; <b>${esc(teamName(winner.id))}</b> lifts the Palwin Ham Cup with ${winner.pts} Trough points. Nobody can take this away, though many will try.</p>` : ''}
    ${rows.map((r, k) => r.entered ? `<div class="lrow" style="justify-content:space-between"><span><span class="muted">${k + 1}</span> ${esc(teamName(r.id))}</span><b class="${k === 0 ? 'gold' : ''}">${r.pts}</b></div>`
      : `<div class="lrow" style="justify-content:space-between;opacity:.55"><span>${esc(teamName(r.id))}</span><span class="muted" style="font-size:11px">no XI — scared of the Trough</span></div>`).join('')}
  </div>`;
}
function bindCup() {
  const draw = $('#hamDraw');
  if (draw) draw.onclick = () => {
    if (netOn() && !isCommissioner()) { toast('Only the Chairman holds the velvet bag'); return; }
    const cur = currentGwIndex();
    const from = Math.min(cur + 2, REGULAR_GWS - 1);
    const gw = from + Math.floor(Math.random() * Math.max(1, REGULAR_GWS - from));
    state.hamCup = { gw, drawnAt: new Date().toISOString(), entries: {} };
    pushShared('hamCup', state.hamCup);
    save(); render();
    playSound('cheer');
    toast(`THE HAM CUP IS DRAWN — GW${GAMEWEEKS[gw].n}. Palwin corks are popping.`);
  };
  const cancel = $('#hamCancel');
  if (cancel) cancel.onclick = () => {
    if (netOn() && !isCommissioner()) { toast('Only the Chairman calls it off'); return; }
    if (!confirm('Call off the Ham Cup — for EVERYONE?')) return;
    state.hamCup = null;
    pushShared('hamCup', null);
    save(); render();
    toast('The Ham Cup is off. Palwin has withdrawn its sponsorship in disgust.');
  };
  document.querySelectorAll('[data-ham]').forEach(cb => cb.onchange = () => {
    const pid = +cb.dataset.ham;
    const cur = hamView.sel ?? toArr(state.hamCup?.entries?.[whoami] || []);
    hamView.sel = cb.checked ? [...cur, pid] : cur.filter(x => x !== pid);
    if (hamView.sel.length > 11) { hamView.sel = cur; toast('Eleven. It’s an XI.'); }
    render();
  });
  const hq = $('#hamQ');
  if (hq) { hq.oninput = () => { hamView.q = hq.value; render(); }; }
  const hs = $('#hamSave');
  if (hs) hs.onclick = () => {
    if (!whoami || whoami === -1) { toast('Sign in first'); return; }
    const sel = hamView.sel ?? toArr(state.hamCup?.entries?.[whoami] || []);
    if (!xiValid(sel)) { toast('That XI is illegal, even for the Ham Cup'); return; }
    state.hamCup.entries = state.hamCup.entries || {};
    state.hamCup.entries[whoami] = sel;
    pushShared(`hamCup/entries/${whoami}`, sel);
    hamView.sel = null;
    save(); render();
    toast('Ham XI entered. May God have mercy.');
  };
}

/* ----- league table ----- */
function viewTable() {
  const ranked = [...state.managers]
    .map(m => ({ ...m, pts: managerPoints(m.id) }))
    .sort((a, b) => b.pts - a.pts);
  const allDrafted = [...new Set(state.draft.picks.map(pk => pk.playerId).concat(state.transfers.map(t => t.inId)))]
    .map(pid => ({ p: PLAYER_BY_ID[pid], pts: playerPoints(pid).pts }))
    .sort((a, b) => b.pts - a.pts).slice(0, 10);
  const hasPts = ranked.some(r => r.pts !== 0);
  const investigation = hasPts
    ? `<div class="card investigation"><span class="rec"></span><b>INVESTIGATION UPDATE</b> &mdash; ${esc(investigationLine(ranked[0].name, ranked[ranked.length - 1].name))}</div>`
    : '';
  return `
    ${investigation}
    ${ranked.map((m, i) => {
      const commTag = !hasPts ? '' :
        i === 0 ? '<span class="tag">&#128269; under Committee review</span>' :
        i === ranked.length - 1 ? '<span class="tag">&#129379; Chumpionship form (abolished)</span>' : '';
      return `
      <div class="league-row ${i === 0 && m.pts > 0 ? 'leader' : ''}" data-mgr-row="${m.id}" style="cursor:pointer">
        <span class="rank">${i + 1}</span>
        <span class="lname">${esc(m.team || m.name)} <span class="muted" style="font-size:11.5px;font-weight:400">${esc(m.name)}</span> ${i === 0 && m.pts > 0 ? '&#127942;' : ''} ${commTag}</span>
        <span class="lpts">${m.pts}</span>
      </div>
      <div class="breakdown" id="bd-${m.id}" style="display:none">
        ${managerSquad(m.id).map(p => ({ p, c: contributedPoints(m.id, p.id), r: playerPoints(p.id) }))
          .sort((a, b) => b.c - a.c)
          .map(({ p, c, r }) => `<div class="squad-row" title="Season: ${esc(r.lines.join(' · ') || 'nothing yet')}"><span class="pos-badge pos-${p.pos}">${p.pos}</span>${photoImg(p)}<span>${esc(p.name)}</span><span class="muted" style="margin-left:8px;font-size:11.5px">${esc(r.lines.join(' · '))}</span><span class="sp-pts">${c}</span></div>`).join('') || '<span class="muted">Empty squad</span>'}
        <p class="muted" style="font-size:11px;margin-top:8px">Points shown are what each player banked while in the starting XI.</p>
      </div>`;
    }).join('')}
    <div class="card toplist" style="margin-top:24px">
      <h2>Trough activity <span class="muted" style="font-weight:400;font-size:12px">who can't leave it alone</span></h2>
      ${(() => {
        const rows = state.managers.map(m => {
          const mine = state.transfers.filter(t => t.managerId === m.id);
          return {
            id: m.id,
            signs: mine.filter(t => !t.trade && !t.waiver).length,
            claims: mine.filter(t => t.waiver).length,
            trades: mine.filter(t => t.trade).length,
            total: mine.length,
          };
        }).sort((a, b) => b.total - a.total);
        const max = rows[0]?.total || 0;
        return `<table class="pool-table">
          <thead><tr><th>Manager</th><th class="num">Trough signings</th><th class="num">Waiver claims won</th><th class="num">Trades</th><th class="num">Total moves</th></tr></thead>
          <tbody>${rows.map((r, i) => `<tr>
            <td><b>${esc(teamName(r.id))}</b> <span class="muted" style="font-size:11px">${esc(managerName(r.id))}</span>
              ${max > 0 && i === 0 ? '<span class="tag">&#128055; lives at the Trough</span>' : ''}
              ${max > 0 && i === rows.length - 1 && r.total === 0 ? '<span class="tag">hasn\'t touched his team</span>' : ''}</td>
            <td class="num">${r.signs}</td><td class="num">${r.claims}</td><td class="num">${r.trades}</td>
            <td class="num gold">${r.total}</td>
          </tr>`).join('')}</tbody>
        </table>`;
      })()}
      ${(() => {
        const counts = {};
        for (const t of state.transfers) {
          if (t.trade) continue; // trades aren't the Trough
          for (const pid of [t.inId, t.outId]) counts[pid] = (counts[pid] || 0) + 1;
        }
        const hot = Object.entries(counts).map(([pid, n]) => ({ p: PLAYER_BY_ID[pid], n }))
          .filter(x => x.p && x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 8);
        return hot.length ? `<h3 style="margin-top:16px">Hot potatoes &#129364; <span class="muted" style="font-weight:400;font-size:11.5px">most passed through the Trough</span></h3>
          ${hot.map(({ p, n }) => `<div class="squad-row"><span class="pos-badge pos-${p.pos}">${p.pos}</span>${photoImg(p)}<span>${pname(p)}</span><span class="muted" style="margin-left:8px;font-size:11.5px">${esc(p.club)}</span><span class="sp-pts">${n} moves</span></div>`).join('')}` : '';
      })()}
    </div>
    <div class="card toplist" style="margin-top:24px">
      <h2>Top players (all drafted &amp; signed)</h2>
      ${allDrafted.map(({ p, pts }) => `
        <div class="squad-row"><span class="pos-badge pos-${p.pos}">${p.pos}</span>${photoImg(p)}
        <span>${esc(p.name)}</span> <span class="muted" style="font-size:11px">${esc(p.club)}</span>
        <span class="sp-pts gold">${pts}</span></div>`).join('') || '<span class="muted">Points appear once matches are played and synced.</span>'}
    </div>`;
}
function bindTable() {
  document.querySelectorAll('[data-mgr-row]').forEach(row => row.onclick = () => {
    const bd = $(`#bd-${row.dataset.mgrRow}`);
    bd.style.display = bd.style.display === 'none' ? 'block' : 'none';
  });
}

/* ----- fixtures ----- */
let fxView = { gw: null };
function viewFixtures() {
  if (!state.fixtures.length) {
    return `<div class="card" style="text-align:center;padding:50px">
      <h2>No fixtures loaded yet</h2>
      <p class="muted" style="margin:10px 0 18px">Tap the lines to pull the season's schedule and any results.</p>
      <button class="btn" onclick="syncNow(true)">&#128222; Tap the lines</button></div>`;
  }
  if (fxView.gw == null) fxView.gw = GAMEWEEKS[currentGwIndex()].n;
  const fxs = state.fixtures.filter(f => f.gw === fxView.gw);
  const byDay = {};
  for (const f of fxs) {
    const d = new Date(f.date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    (byDay[d] = byDay[d] || []).push(f);
  }
  return `
  <div class="team-controls card">
    <select id="fxGw">${GAMEWEEKS.map(g => `<option value="${g.n}" ${g.n === fxView.gw ? 'selected' : ''}>GW${g.n}${g.n === GAMEWEEKS[currentGwIndex()].n ? ' (current)' : ''}</option>`).join('')}</select>
  </div>
  ${Object.entries(byDay).map(([day, list]) => `
    <div class="fx-day"><h3>${day}</h3><div class="fx-grid">
    ${list.map(f => {
      const live = f.started && !f.finished;
      const score = !f.started ? new Date(f.date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : `${f.hs ?? ''}–${f.as ?? ''}`;
      return `<div class="fx ${live ? 'live' : ''}">
        <div class="fx-team right"><span>${esc(f.home)}</span>${flagImg(f.home)}</div>
        <span class="fx-score">${score}</span>
        <div class="fx-team"><span>${flagImg(f.away)}</span><span>${esc(f.away)}</span></div>
        <span class="fx-time">${live ? `${f.minutes}'` : (f.finished ? 'FT' : '')}</span>
      </div>`;
    }).join('')}
    </div></div>`).join('') || '<div class="card"><p class="muted">No fixtures scheduled for this gameweek yet.</p></div>'}`;
}
function bindFixtures() {
  const sel = $('#fxGw');
  if (sel) sel.onchange = e => { fxView.gw = +e.target.value; render(); };
}

/* ----- rules ----- */
const HONOURS_BOARD = [
  ['2015–16', 'Toby Levy', '*'], ['2016–17', 'Marc Conway', '*'], ['2017–18', 'Ian Tussie', '*'],
  ['2018–19', 'Marc Conway', '**'], ['2019–20', 'Ben Polak', '*'], ['2020–21', 'Alex Singer', '*'],
  ['2021–22', 'Alex Singer', '**'], ['2022–23', 'Alex Duckett', '*'], ['2023–24', 'Ian Tussie', '**'],
  ['2024–25', 'Richard Blank', '*'], ['2025–26', 'Adam Jackson', '*'],
];
function viewRules() {
  const sc = state.settings.scoring;
  const { posMin, posMax } = state.settings;
  return `
  <div class="settings-grid">
    <div class="card">
      <h2>The basics</h2>
      <p class="rules-p">Twelve managers. One snake draft over all ${PLAYERS.length} Premier League players — order reverses every round. Est. 2015; this is season twelve.</p>
      <p class="rules-p">Squads of <b>${state.settings.squadSize}</b>, flexible make-up: ${['GK', 'DF', 'MF', 'FW'].map(p => `${posMin[p]}–${posMax[p]} ${p}`).join(', ')}. <b>No club cap.</b> Tussie may draft the entire City team by GW30. That is his right.</p>
      <p class="rules-p"><b>Starting XI:</b> pick 11 from your ${state.settings.squadSize} each gameweek — 1 GK, 3–5 DF, 2–5 MF, 1–3 FW. <b>Only starters score.</b> Lineups lock at the FPL deadline.</p>
      <p class="rules-p"><b>Forgot to set it?</b> Last week's XI carries over (or a best XI is auto-picked). Nobody scores nil for being on holiday.</p>
      <p class="rules-p"><b>Auto-subs:</b> if a starter doesn't play at all that gameweek, your bench comes in automatically <b>in the order you've set</b> — leftmost first (tap two bench players on the pitch view to reorder).</p>
      <h3>The season</h3>
      <p class="rules-p"><b>GW1–33</b>: regular season, head-to-head every week — everyone plays everyone, nearly three times over. Win 3, draw 1, loss 0.</p>
      <p class="rules-p"><b>GW34</b>: playoff semi-finals, one leg — 1st v 4th, 2nd v 3rd.</p>
      <p class="rules-p"><b>GW35–36</b>: the final, two legs. One win each → cumulative points. Still level → higher regular-season finish takes it.</p>
      <p class="rules-p"><b>The Monzo League Cup</b>, from GW8: last man standing. Lowest score each gameweek is eliminated; ties roll over.</p>
    </div>
    <div class="card">
      <h2>Scoring</h2>
      ${Object.keys(DEFAULT_SCORING).map(k => `<div class="score-row"><span>${SCORING_LABELS[k]}</span><b class="gold">${sc[k] > 0 ? '+' : ''}${sc[k]}</b></div>`).join('')}
      <p class="muted" style="font-size:11.5px;margin-top:8px">Raw stats from the official FPL feed, scored by our table above. No captains. No bonus-point nonsense. Double gameweeks score on the week's combined stats.</p>
      <h3 style="margin-top:16px">Waivers &amp; trades</h3>
      <p class="rules-p"><b>Waivers:</b> everyone goes on waivers when a gameweek starts, and dropped players go back on waivers. Lodge ranked claims (blind); they resolve <b>Tuesdays &amp; Fridays at 10:00 UTC</b> in reverse table order — win a claim, drop to the back. The Chairman can run waivers early, or open/close the Trough entirely.</p>
      <p class="rules-p"><b>The Trough:</b> whatever clears waivers is a free agent — first come, first served, instant. Squads stay at 14; someone always goes out.</p>
      <p class="rules-p"><b>The Window:</b> anyone who joins a Premier League club after draft night is locked away until the transfer window shuts. The Chairman then runs the <b>Window Draft</b> — first pick to whoever picked last on draft night, snaking back up, until a full lap of passes. Whatever's left spills into the Trough.</p>
      <p class="rules-p"><b>January:</b> new signings can't be taken until the window shuts — then it's bottom of the league up. Knitty-grittys confirmed nearer the time, as is tradition.</p>
      <p class="rules-p"><b>Trades:</b> player-for-player swaps between managers, agreed in the group, any time until the playoff lock. Doesn't use your waiver turn.</p>
      <p class="rules-p"><b>Playoff lock:</b> after GW33, non-playoff teams are frozen — no waivers, no trades, no passing players back.</p>
    </div>
    <div class="card">
      <h2>Honours board &#127942;</h2>
      ${HONOURS_BOARD.map(([yr, who, stars]) => `<div class="score-row"><span>${yr}</span><b>${esc(who)} ${stars}</b></div>`).join('')}
      <h3 style="margin-top:16px">Prize money</h3>
      <p class="rules-p">£50 each. Last season's split: £250 playoff winner, £130 runner-up, £75 last man standing — and <b>£145 to the site</b>. The site now costs <b>£0</b>, because we built our own. That's £145 back in the pot; redistribution to be argued about in the group chat. Vive la révolution.</p>
      <h3 style="margin-top:16px">The small print</h3>
      <p class="rules-p">Stats sync automatically from the official FPL feed (goals land within ~15 minutes on matchdays). The commissioner (${esc(managerName(state.managers[0]?.id))}) settles disputes, can act for absent managers, and adjusts points if the feed errs.</p>
      <p class="rules-p muted" style="font-style:italic">All decisions are final. Complaints may be lodged in the group chat, where they will be enjoyed. — The Committee</p>
    </div>
  </div>
  ${recordBookCards()}`;
}

/* ----- the Record Book — mined from Draft Fantasy before the lights went out ----- */
function recordBookCards() {
  if (typeof LEAGUE_HISTORY === 'undefined' || !LEAGUE_HISTORY.length) return '';
  return LEAGUE_HISTORY.map(S => {
    const rows = S.managers.map((m, i) => ({ i, team: m.team, name: m.name, p: 0, w: 0, d: 0, l: 0, pf: 0, pa: 0, pts: 0 }));
    let hi = null, lo = null, hiding = null;
    for (const [gw, h, a, hp, ap] of S.matches) {
      const H = rows[h], A = rows[a];
      H.p++; A.p++; H.pf += hp; H.pa += ap; A.pf += ap; A.pa += hp;
      if (hp > ap) { H.w++; A.l++; } else if (hp < ap) { A.w++; H.l++; } else { H.d++; A.d++; }
      for (const [idx, pts] of [[h, hp], [a, ap]]) {
        if (!hi || pts > hi.pts) hi = { idx, pts, gw };
        if (!lo || pts < lo.pts) lo = { idx, pts, gw };
      }
      const margin = Math.abs(hp - ap);
      if (margin && (!hiding || margin > hiding.margin)) hiding = { margin, gw, w: hp > ap ? h : a, l: hp > ap ? a : h, ws: Math.max(hp, ap), ls: Math.min(hp, ap) };
    }
    rows.forEach(r => { r.pts = 3 * r.w + r.d; });
    const table = [...rows].sort((x, y) => y.pts - x.pts || y.pf - x.pf);
    const hon = S.honours || {};
    const isChamp = r => hon.champion && r.name === hon.champion.name;
    const isTopped = r => hon.regularSeason && r.name === hon.regularSeason.name;
    // head-to-head ledger: row's record against column, all meetings
    const grid = rows.map(() => rows.map(() => ({ w: 0, d: 0, l: 0 })));
    for (const [, h, a, hp, ap] of S.matches) {
      if (hp > ap) { grid[h][a].w++; grid[a][h].l++; }
      else if (hp < ap) { grid[h][a].l++; grid[a][h].w++; }
      else { grid[h][a].d++; grid[a][h].d++; }
    }
    const init = t => esc(t.split(/\s+/).map(w => (w.codePointAt(0) < 128 ? w[0] : '')).join('').slice(0, 3).toUpperCase() || t.slice(0, 3).toUpperCase());
    const rec = (icon, label, text) => `<div class="lrow" style="font-size:12.5px"><span style="width:22px">${icon}</span><b style="min-width:170px">${label}</b><span>${text}</span></div>`;
    return `
    <div class="card" style="margin-top:18px">
      <h2>The Record Book — ${esc(S.season)} <span class="muted" style="font-weight:400;font-size:12px">mined from Draft Fantasy before we turned the lights off</span></h2>
      ${hon.champion ? `<p class="rules-p">&#127942; <b>Champion: ${esc(hon.champion.team.replace(/\*+$/, ''))}</b> (${esc(hon.champion.name)}) — ${esc(hon.champion.note || 'won the playoffs')}. ${hon.regularSeason ? `${esc(hon.regularSeason.team)} ${esc(hon.regularSeason.note || 'topped the table')}.` : ''}</p>` : ''}
      ${hon.caveat ? `<p class="rules-p muted" style="font-size:11.5px;font-style:italic">${esc(hon.caveat)}</p>` : ''}
      <div style="overflow-x:auto">
      <table class="pool-table" style="font-size:12px">
        <thead><tr><th></th><th>Team</th><th class="num">P</th><th class="num">W</th><th class="num">D</th><th class="num">L</th><th class="num">+</th><th class="num">&minus;</th><th class="num">Pts</th></tr></thead>
        <tbody>${table.map((r, k) => `<tr>
          <td class="muted">${k + 1}</td>
          <td style="white-space:nowrap"><b>${esc(r.team)}</b> <span class="muted" style="font-size:11px">${esc(r.name)}</span>${isChamp(r) ? ' &#127942;' : ''}${isTopped(r) ? ' <span class="tag" title="Topped the table, lost the playoffs">table</span>' : ''}</td>
          <td class="num">${r.p}</td><td class="num">${r.w}</td><td class="num">${r.d}</td><td class="num">${r.l}</td>
          <td class="num muted">${r.pf}</td><td class="num muted">${r.pa}</td><td class="num gold">${r.pts}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <h3 style="margin-top:14px">Season records</h3>
      ${hi ? rec('&#128293;', 'Highest score', `<b>${esc(rows[hi.idx].team)}</b> — ${hi.pts} points, GW${hi.gw}`) : ''}
      ${lo ? rec('&#128128;', 'Lowest score', `<b>${esc(rows[lo.idx].team)}</b> — ${lo.pts} points, GW${lo.gw}`) : ''}
      ${hiding ? rec('&#128296;', 'Biggest hiding', `<b>${esc(rows[hiding.w].team)}</b> ${hiding.ws}&ndash;${hiding.ls} <b>${esc(rows[hiding.l].team)}</b>, GW${hiding.gw}`) : ''}
    </div>
    <div class="card" style="margin-top:14px">
      <h2>Head-to-head ledger — ${esc(S.season)} <span class="muted" style="font-weight:400;font-size:12px">row's record vs column (W-D-L), grudges included</span></h2>
      <div style="overflow-x:auto">
      <table class="pool-table" style="font-size:11px">
        <thead><tr><th></th>${rows.map(c => `<th class="num" title="${esc(c.team)}">${init(c.team)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r, i) => `<tr>
          <td style="white-space:nowrap"><b title="${esc(r.name)}">${esc(r.team)}</b></td>
          ${rows.map((c, j) => i === j ? '<td class="num muted">—</td>' : `<td class="num" style="white-space:nowrap;${grid[i][j].w > grid[i][j].l ? 'color:#3fb96d' : grid[i][j].w < grid[i][j].l ? 'color:#e05555' : ''}">${grid[i][j].w}-${grid[i][j].d}-${grid[i][j].l}</td>`).join('')}
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="muted" style="font-size:10.5px;margin-top:6px">All ${S.matches.length} meetings, ${esc(S.season)}. Earlier seasons join the Book as they're recovered from Draft Fantasy's archives.</p>
    </div>`;
  }).join('');
}

/* ----- settings ----- */
function viewSettings() {
  const sc = state.settings.scoring;
  return `<div class="settings-grid">
    <div class="card">
      <h2>Scoring rules</h2>
      ${Object.keys(DEFAULT_SCORING).map(k => `
        <div class="score-row"><span>${SCORING_LABELS[k]}</span>
        <input type="number" step="1" data-score="${k}" value="${sc[k]}"></div>`).join('')}
      <div class="score-row" style="margin-top:8px;border-top:1px dashed var(--line);padding-top:8px"><span>Lobus bonus <span class="muted" style="font-size:11px">(0 = off; +N any GW your starting Lobus scores or assists — ledger #1, Committee approval pending)</span></span>
      <input type="number" step="1" id="lobusBonus" value="${+state.settings.lobusBonus || 0}"></div>
      <p class="muted" style="margin-top:10px;font-size:12px">Only your starting XI scores each gameweek. Changes apply instantly to all past and future matches.</p>
    </div>
    <div class="card">
      <h2>League admin</h2>
      <div style="display:flex;flex-direction:column;gap:10px">
        <button class="btn ghost" id="demoBtn2">Demo mode — preview with fake results</button>
        <button class="btn ghost" id="exportBtn">Export league file (backup)</button>
        <label class="btn ghost" style="text-align:center;cursor:pointer">Import league file<input type="file" id="importFile" accept=".json" style="display:none"></label>
        <button class="btn danger" id="resetBtn">Reset everything</button>
      </div>
      <p class="muted" style="font-size:12px;margin-top:10px">One file is the truth. Commissioner makes lineup/transfer changes, exports, drops it in the group; everyone else imports.</p>
      <h3 style="margin-top:18px">PIN resets</h3>
      <p class="muted" style="font-size:12px;margin-bottom:8px">Forgotten PINs go to the Chairman. Reset lets the manager set a new one on next sign-in.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <select id="pinMgr" style="flex:1;min-width:160px">
          <option value="">Pick a manager…</option>
          ${state.managers.filter(m => state.pins?.[m.id]).map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}
        </select>
        <button class="btn small" id="pinReset">Reset PIN</button>
      </div>
      <h3 style="margin-top:18px">Manual point adjustments</h3>
      <p class="muted" style="font-size:12px;margin-bottom:8px">If a stat feed gets something wrong, add/subtract points per player.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <select id="adjPlayer" style="flex:1;min-width:200px">
          <option value="">Pick a player…</option>
          ${state.managers.flatMap(m => managerSquad(m.id).map(p => `<option value="${p.id}">${esc(p.name)} (${esc(m.name)})</option>`)).join('')}
        </select>
        <input type="number" id="adjPts" placeholder="±pts" style="width:90px">
        <button class="btn small" id="adjApply">Apply</button>
      </div>
      ${Object.entries(state.adjustments).filter(([, v]) => v).map(([pid, v]) =>
        `<div class="score-row"><span>${esc(PLAYER_BY_ID[pid]?.name)}</span><span class="gold">${v > 0 ? '+' : ''}${v}</span></div>`).join('')}
    </div>
    <div class="card">
      <h2>The Constitution <span class="muted" style="font-weight:400;font-size:12px">read-only, as all constitutions should be</span></h2>
      <p class="rules-p">&sect;1 The title is the playoffs. The table is for arguing.</p>
      <p class="rules-p">&sect;2 Twelve managers, £50 a head, est. 2015. The waiting list is ten years deep and moving slowly.</p>
      <p class="rules-p">&sect;3 No club cap. Tussie's right to hoard the entire City squad is constitutionally protected.</p>
      <p class="rules-p">&sect;4 Waivers run Tuesdays and Fridays, 10:00 UTC, reverse table order. The Trough takes the rest.</p>
      <p class="rules-p">&sect;5 New signings wait for the Window Draft. January is bottom-up, knitty-grittys nearer the time, as is tradition.</p>
      <p class="rules-p">&sect;6 Every manager declares one (1) Lobus. The klaxon is ceremonial until the Committee says otherwise.</p>
      <p class="rules-p">&sect;7 Side deals belong in the Covenant Register, where they are timestamped, witnessed and mocked.</p>
      <p class="rules-p">&sect;8 The hydration break is inviolable.</p>
      <p class="rules-p muted" style="font-style:italic">Amendments require a Committee majority and will be ignored regardless. Full rules on the Rules page.</p>
    </div>
  </div>`;
}
function bindSettings() {
  document.querySelectorAll('[data-score]').forEach(inp => inp.onchange = () => {
    if (netOn() && !isCommissioner()) { toast('Only the commissioner changes scoring'); render(); return; }
    state.settings.scoring[inp.dataset.score] = +inp.value || 0;
    pushShared(`settings/scoring/${inp.dataset.score}`, state.settings.scoring[inp.dataset.score]);
    save(); toast('Scoring updated');
  });
  const lb = $('#lobusBonus');
  if (lb) lb.onchange = () => {
    if (netOn() && !isCommissioner()) { toast('Only the commissioner changes scoring'); render(); return; }
    state.settings.lobusBonus = +lb.value || 0;
    pushShared('settings/lobusBonus', state.settings.lobusBonus);
    save(); toast(state.settings.lobusBonus ? `Lobus bonus live: +${state.settings.lobusBonus}. Marc will be told.` : 'Lobus bonus off. The klaxon stays ceremonial.');
  };
  $('#demoBtn2').onclick = enterDemo;
  $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'the-league-2627.json';
    a.click();
    toast('League file downloaded');
  };
  $('#importFile').onchange = e => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then(txt => {
      try {
        const imported = JSON.parse(txt);
        if (!imported.managers || !imported.draft) throw new Error('bad file');
        if (!imported.lineups) { imported.lineups = {}; imported.transfers = []; }
        if (!imported.waivers) imported.waivers = {};
        state = imported;
        if (netOn() && isCommissioner()) publishAll();
        save(); render(); toast('League imported');
      } catch { toast('That file doesn’t look like a league export'); }
    });
  };
  $('#resetBtn').onclick = () => {
    if (netOn() && !isCommissioner()) { toast('Only the commissioner can reset the league'); return; }
    if (confirm('Wipe the league, draft and all scores — for EVERYONE?')) {
      state = freshState();
      localStorage.removeItem('tl2627-ceremony-seen');
      // rules only allow deleting a league that is back in setup — flip, then wipe
      if (netOn()) window.WCSync.set('phase', 'setup').then(() => window.WCSync.setRoot(null)).catch(e => console.warn('[sync] wipe failed', e));
      save(); render();
    }
  };
  const pr = $('#pinReset');
  if (pr) pr.onclick = () => {
    if (netOn() && !isCommissioner()) { toast('Only the Chairman resets PINs'); return; }
    const mid2 = +$('#pinMgr').value;
    if (!mid2) return;
    delete state.pins[mid2];
    pushShared(`pins/${mid2}`, null);
    save(); render();
    toast(`${managerName(mid2)}'s PIN cleared — they'll set a new one on next sign-in`);
  };
  $('#adjApply').onclick = () => {
    if (netOn() && !isCommissioner()) { toast('Only the commissioner adjusts points'); return; }
    const pid = +$('#adjPlayer').value, pts = +$('#adjPts').value || 0;
    if (!pid) return;
    state.adjustments[pid] = (state.adjustments[pid] || 0) + pts;
    pushShared(`adjustments/${pid}`, state.adjustments[pid]);
    save(); render(); toast('Adjustment applied');
  };
}

/* ---------------- player stats card ---------------- */
function showPlayerCard(pid) {
  const p = PLAYER_BY_ID[pid];
  if (!p) return;
  $('#pcardOverlay')?.remove();
  const owner = state.managers.find(m => managerSquad(m.id).some(x => x.id === pid));
  const pp = playerPoints(pid);
  const gwRows = [];
  for (let i = GAMEWEEKS.length - 1; i >= 0; i--) {
    const s = gwEvent(i)?.playerStats?.[pid];
    if (!s) continue;
    const bits = [];
    if (s.g) bits.push(`\u26bd\u00d7${s.g}`);
    if (s.a) bits.push(`A\u00d7${s.a}`);
    if (s.cs) bits.push('CS');
    if (s.ps) bits.push('pen save');
    if (s.yc) bits.push('\ud83d\udfe8');
    if (s.rc) bits.push('\ud83d\udfe5');
    if (s.og) bits.push('OG');
    gwRows.push(`<div class="score-row"><span>GW${GAMEWEEKS[i].n} <span class="muted" style="font-size:11px">${s.min || 0}&prime; ${bits.join(' ')}</span></span><b class="${gwPlayerPoints(pid, i) > 0 ? 'gold' : 'muted'}">${gwPlayerPoints(pid, i)}</b></div>`);
  }
  const ov = document.createElement('div');
  ov.id = 'pcardOverlay';
  ov.className = 'overlay';
  ov.innerHTML = `<div class="card pcard">
    <div class="pcard-head">
      <img class="pcard-photo" src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" onerror="this.onerror=null;this.src='https://resources.premierleague.com/premierleague/photos/players/110x140/Photo-Missing.png'" alt="">
      <div>
        <h2 style="margin-bottom:2px">${esc(p.name)} <span class="pos-badge pos-${p.pos}">${p.pos}</span></h2>
        <p class="muted" style="font-size:12px">${esc(p.full)}</p>
        <p style="font-size:13px;margin-top:4px">${flagImg(p.team)} ${esc(p.team)} &middot; \u00a3${p.price.toFixed(1)}m</p>
        ${p.news ? `<p class="warn" style="font-size:12px;margin-top:4px">${statusChip(p)} ${esc(p.news)}</p>` : ''}
        <p class="muted" style="font-size:12px;margin-top:4px">${owner ? `Owned by <b style="color:var(--text)">${esc(teamName(owner.id))}</b>` : 'Free agent' + (state.phase === 'season' && onWaivers(p) ? ' \u2014 on waivers' : ' \u2014 in the Trough')}</p>
      </div>
      <button class="btn ghost small" id="pcardClose" style="margin-left:auto">\u2715</button>
    </div>
    <div class="quota-bar" style="margin:10px 0">
      <span class="quota-pill">League pts <b class="gold">&nbsp;${pp.pts}</b></span>
      <span class="quota-pill">FPL official ${p.pts}</span>
      <span class="quota-pill" title="FPL expected points, next gameweek">xPts next ${playerXp(p).toFixed(1)}</span>
    </div>
    ${(() => {
      const ls = lastSeasonOf(p);
      return ls ? `<p class="muted" style="font-size:12px;margin-bottom:8px"><b style="color:var(--text)">${LS_SEASON}:</b> ${ls.pts} FPL pts &middot; ${ls.g} G &middot; ${ls.a} A &middot; ${ls.cs} CS &middot; ${ls.ppg} per game &middot; ${Math.round((ls.mp || 0) / 90)} &times; 90s${ls.club && ls.club !== p.club ? ` <span class="muted">(at ${esc(ls.club)})</span>` : ''}</p>`
        : `<p class="muted" style="font-size:12px;margin-bottom:8px">No ${LS_SEASON} record — new to the Premier League.</p>`;
    })()}
    ${pp.lines.length ? `<p class="muted" style="font-size:12px;margin-bottom:8px">${esc(pp.lines.join(' \u00b7 '))}</p>` : ''}
    ${(() => {
      const hist = [];
      const pk = state.draft.picks.find(x => x.playerId === pid);
      if (pk) hist.push(`Drafted pick #${pk.n} by ${teamName(pk.managerId)}`);
      for (const t of state.transfers) {
        if (t.inId === pid) hist.push(`GW${GAMEWEEKS[t.gw].n}: ${t.trade ? 'traded to' : t.waiver ? 'claimed off waivers by' : 'signed from the Trough by'} ${teamName(t.managerId)}`);
        else if (t.outId === pid && !t.trade) hist.push(`GW${GAMEWEEKS[t.gw].n}: dropped by ${teamName(t.managerId)}`);
      }
      return hist.length ? `<p class="muted" style="font-size:11.5px;margin-bottom:8px"><b style="color:var(--text)">History:</b> ${hist.map(esc).join(' \u00b7 ')}</p>` : '';
    })()}
    <div style="max-height:260px;overflow-y:auto">${gwRows.join('') || '<p class="muted" style="font-size:12px">No gameweek data yet this season.</p>'}</div>
    <div id="pcardActions" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px"></div>
    <p class="muted" style="font-size:10.5px;margin-top:8px">League pts use our scoring (no bonus). FPL official shown for arguments.</p>
  </div>`;
  ov.onclick = e => { if (e.target === ov || e.target.id === 'pcardClose') closeOv(ov); };
  document.body.appendChild(ov);
  pushOvState(); // phone back button closes the card, not the site
  // context actions — the card is a place to DO things, not just read them
  const acts = ov.querySelector('#pcardActions');
  const btn = (label, fn, ghost = false) => {
    const b = document.createElement('button');
    b.className = `btn small${ghost ? ' ghost' : ''}`;
    b.innerHTML = label;
    b.onclick = e => { e.stopPropagation(); fn(); };
    acts.appendChild(b);
  };
  const iAmManager = whoami && whoami !== -1;
  if (state.phase === 'draft' && !draftedIds().has(pid)) {
    const myTurn = currentManagerId() != null && canActFor(currentManagerId()) && canPick(currentManagerId(), p);
    if (myTurn) btn('Draft him', () => { ov.remove(); makePick(pid); });
    if (iAmManager && !toArr(state.autolists?.[whoami]).includes(pid)) {
      btn('&#9734; Add to autopick list', () => { setAutolist(whoami, [...toArr(state.autolists?.[whoami]), pid]); ov.remove(); toast(`${p.name} added to your list`); }, true);
    }
  }
  if (state.phase === 'season' && iAmManager) {
    if (!owner) {
      btn(onWaivers(p) ? 'Claim in Transfers' : 'Sign in Transfers', () => {
        ov.remove();
        window._troughFocus = p.name;
        transfersView.tab = 'trough'; state.view = 'transfers'; save(); render();
      });
    } else if (owner.id !== whoami) {
      btn('Propose a trade', () => {
        ov.remove();
        window._tradeFocus = { other: owner.id, get: pid };
        transfersView.tab = 'trades'; state.view = 'transfers'; save(); render();
      });
    } else {
      const listed = blockList(whoami).includes(pid);
      btn(listed ? 'Take off the trade block' : '&#128276; Put on the trade block', () => {
        ov.remove();
        toggleBlock(whoami, pid);
        toast(listed ? `${p.name} quietly delisted.` : `${p.name} is on the block. Offers invited.`);
      }, true);
      // one mandatory Lobus per manager (ledger #1) — changeable until GW1 kicks off
      const myLob = state.lobus?.[whoami];
      if (myLob === pid) {
        btn('&#128239; Your declared Lobus', () => toast('He is your Lobus. There is no undo, only a new Lobus.'), true);
      } else if (!myLob || !gwHasStarted(0)) {
        btn('&#128239; Declare my Lobus', () => {
          ov.remove();
          state.lobus[whoami] = pid;
          pushShared(`lobus/${whoami}`, pid);
          save(); render();
          playSound('cheer');
          toast(`LOBUS KLAXON — ${p.name} is now ${managerName(whoami)}'s Lobus. Big unit. Great feet for a big man.`);
        }, true);
      }
    }
    // from your own pitch view: start a swap from the card, finish it with a tap
    if (owner && state.view === 'team' && owner.id === teamView.mid && canActFor(owner.id) && (demoMode || !gwHasStarted(teamView.gw))) {
      btn('&#8646; Swap / move him', () => {
        ov.remove();
        teamView.pitchSel = pid;
        render();
        toast('Now tap the teammate to swap with');
      }, true);
    }
  }
}
// any player photo/kit anywhere opens the card (capture phase beats row handlers)
document.addEventListener('click', e => {
  const t = e.target.closest?.('[data-pcard]');
  if (!t) return;
  // mid-swap on your own pitch: the tap completes the swap instead of opening the card
  if (state.view === 'team' && teamView.pitchSel != null && e.target.closest?.('[data-pitch]')) return;
  e.preventDefault();
  e.stopPropagation();
  showPlayerCard(+t.dataset.pcard);
}, true);

/* ---------------- boot ---------------- */
// a #hash deep-link (or a restored tab) opens straight onto that page
{
  const v0 = location.hash.slice(1);
  if (state.phase !== 'setup' && NAV_ITEMS.some(([k]) => k === v0)) state.view = v0;
}
render();
// ?demo drops visitors straight into the demo season
if (new URLSearchParams(location.search).has('demo')) enterDemo();
// commissioner devices run overdue scheduled waivers automatically
setTimeout(() => {
  if (netOn() && isCommissioner() && waiverRunDue()) processWaivers(false);
}, 4000);
// auto-sync on load during the tournament (max once per 20 min, always if live,
// and always when stats aren't in memory — saves no longer persist them)
if (state.phase === 'season') {
  const stale = !state.lastSync || (Date.now() - new Date(state.lastSync).getTime()) > 20 * 60 * 1000;
  if (stale || anyMatchLive() || !Object.keys(state.matchStats || {}).length) syncNow(false);
}
// stale-build watchdog: long-lived tabs and home-screen installs reload
// themselves when a new version ships (never mid-draft — draft night is sacred)
let appBuildTag = null;
async function checkBuild() {
  try {
    const r = await fetch('js/app.js', { method: 'HEAD', cache: 'no-store' });
    const tag = r.headers.get('etag') || r.headers.get('last-modified');
    if (!tag) return;
    if (appBuildTag === null) { appBuildTag = tag; return; }
    if (tag !== appBuildTag && state.phase !== 'draft' && !document.querySelector('.overlay')) {
      toast('New club shop stock — updating…');
      setTimeout(() => location.reload(), 1500);
    }
  } catch { /* offline — try again next cycle */ }
}
checkBuild();
setInterval(checkBuild, 10 * 60 * 1000);

/* ================= The League — 2026/27 ================= */
'use strict';

const LS_KEY = 'tl2627-league';

const TEAM_BY_NAME = Object.fromEntries(TEAMS.map(t => [t.name, t]));
const PLAYER_BY_ID = Object.fromEntries(PLAYERS.map(p => [p.id, p]));
const POS_ORDER = { GK: 0, DF: 1, MF: 2, FW: 3 };
const POS_LABEL = { GK: 'Goalkeepers', DF: 'Defenders', MF: 'Midfielders', FW: 'Forwards' };
// how many players outrank you on last season's points — used for pundit judgement
const ratingRank = r => PLAYERS.filter(x => (x.rating ?? 0) > r).length;

const DEFAULT_SCORING = {
  appearance: 1,
  appearance60: 2,
  goalGK: 6, goalDF: 6, goalMF: 5, goalFW: 4,
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

/* ---------------- Moggi desk ---------------- */
const MOGGI_QUOTES = [
  'A fine pick. The referees have been informed.',
  'I made three phone calls. He was always coming to you.',
  'Don’t thank me. Officially, we never spoke.',
  'His bookings this tournament will be… managed.',
  'I know his agent. I know everyone’s agent.',
  'The draft order was random, of course. Everything is always random.',
  'He’ll win penalties. I’ve spoken to the right people.',
  'Good. Now delete this conversation.',
  'A bold selection. The linesmen owe me a favour anyway.',
  'Trust the process. The process is me.',
];
const moggiSays = () => `Moggi: “${MOGGI_QUOTES[Math.floor(Math.random() * MOGGI_QUOTES.length)]}”`;

const INTERCEPTS = [
  'Listen carefully, {name}. The player you want… he is already yours. I made the call an hour ago.',
  '{name}, my friend. The other three suspect nothing.',
  'Tell {name} the medical was passed. We did not look too closely.',
  '{name} hesitates. Weakness. In my day we drafted by fax and fear.',
  'The scouts recommended a defender. I recommended ignoring the scouts. {name} understands.',
  'If {name} picks another goalkeeper, the federation will have questions.',
  'The room is clean, {name}. I swept it myself. Twice.',
  '{name} is on the clock. The clock, naturally, reports to me.',
  'Whatever {name} selects, write down that it was always the plan.',
  'Remind {name}: a snake draft has two ends, and I have friends at both.',
];
const interceptFor = (n, name) =>
  INTERCEPTS[n % INTERCEPTS.length].replaceAll('{name}', name);

const INVESTIGATIONS = [
  'Intercepted call, 02:41 — “{L} cannot keep getting away with this. Find out which referees they know.”',
  'The committee notes {L}’s points total “with interest”. {B} has been offered Serie B and a plea deal.',
  'Moggi’s verdict: “{L}? Talented. Connected. Probably both.” {B} has been reported to the authorities, who laughed.',
  'Forensics found nothing on {L}’s phone. Forensics also found that {L} has two phones. {B} has been eliminated from enquiries — and from contention.',
  'An anonymous source close to {L} says it’s all legitimate. The source sounded exactly like {L}.',
];
const investigationLine = (L, B) => {
  const day = new Date().getDate();
  return INVESTIGATIONS[day % INVESTIGATIONS.length].replaceAll('{L}', L).replaceAll('{B}', B);
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
  return pairs;
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

const SHARED_KEYS = ['phase', 'managers', 'settings', 'draft', 'lineups', 'transfers', 'waivers', 'adjustments', 'shirtNums'];
function sharedSnapshot() {
  const o = {};
  for (const k of SHARED_KEYS) o[k] = state[k];
  return o;
}
function pushShared(path, val) {
  if (netOn()) window.WCSync.set(path, val).catch(e => console.warn('[sync] write failed', e));
}
function publishAll() {
  if (netOn()) window.WCSync.setRoot(sharedSnapshot()).catch(e => console.warn('[sync] publish failed', e));
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
  // first sight of a fresh draft on this device → roll the opening ceremony
  const fresh = data.phase === 'draft' && data.draft.picks.length === 0;
  data.transfers = toArr(data.transfers);
  data.lineups = data.lineups || {};
  for (const mid of Object.keys(data.lineups)) {
    data.lineups[mid] = data.lineups[mid] || {};
    for (const gw of Object.keys(data.lineups[mid])) data.lineups[mid][gw] = toArr(data.lineups[mid][gw]);
  }
  data.waivers = data.waivers || {};
  for (const gw of Object.keys(data.waivers)) data.waivers[gw] = { actions: toArr(data.waivers[gw].actions) };
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
    draft: { order: [], picks: [], breaksDone: [], timewastes: {} },
    lineups: {},           // managerId -> { gwIndex: [pid x11] }
    shirtNums: {},         // managerId -> { pid: customNumber }
    transfers: [],         // [{managerId, outId, inId, gw, n, trade?}]
    waivers: {},           // gwIndex -> { actions: [{mid, outId?, inId?, pass?}] }
    fixtures: [],
    matchStats: {},        // 'gw{n}' -> { gw, label, date, final, playerStats: {pid:{min,st,sub,g,a,cs,gc,og,ps,pm,yc,rc,sv}} }
    adjustments: {},
    lastSync: null,
    view: 'draft',
  };
}
function save() { if (!demoMode) localStorage.setItem(LS_KEY, JSON.stringify(state)); }
// last season's FPL points (falls back to price until the new season's data rolls in)
const rating = p => p.rating ?? 0;

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
  return s;
}
function enterDemo() {
  if (demoMode) return;
  demoBackup = state;
  demoMode = true;
  state = buildDemoState();
  render();
  toast('Demo mode — fake draft, fake results. Your real league is untouched.');
}
function exitDemo() {
  state = demoBackup || load() || freshState();
  demoMode = false;
  demoBackup = null;
  render();
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && !s.lineups) { s.lineups = {}; s.transfers = []; } // migrate pre-lineup saves
    if (s && !s.waivers) s.waivers = {};
    if (s && !s.shirtNums) s.shirtNums = {};
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
// official PL headshot, falling back to the league's own "Photo Missing" card
const photoImg = p => `<img class="headshot" loading="lazy" src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" onerror="this.onerror=null;this.src='https://resources.premierleague.com/premierleague/photos/players/110x140/Photo-Missing.png'" alt="${esc(p.name)}">`;
// the actual kit artwork FPL uses (GK variant for keepers)
const kitImg = (team, gk = false) => {
  const t = TEAM_BY_NAME[team];
  return t ? `<img class="kit" loading="lazy" src="https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_${t.code}${gk ? '_1' : ''}-66.png" alt="${esc(team)}" title="${esc(team)}">` : '';
};
// injury/availability chip from the FPL status flag
const STATUS_ICON = { d: '⚠️', i: '🏥', s: '🟥', u: '🚫', n: '🚫' };
const statusChip = p => STATUS_ICON[p.status]
  ? `<span class="status-chip" title="${esc(p.news || 'Unavailable')}">${STATUS_ICON[p.status]}</span>` : '';
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

/* ---------------- gameweek waiver draft ---------------- */
// Weekly waivers: ordered, one swap each, bottom of the table feeds first.
// (A January re-draft window can be flipped on here when the group decides.)
function waiverMode(gwIdx) { return 'ordered'; }
function troughUsed(mid, gwIdx) {
  return (state.waivers?.[gwIdx]?.actions || []).some(a => a.mid === mid);
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
function waiverState(gwIdx) {
  const mode = waiverMode(gwIdx);
  const actions = state.waivers?.[gwIdx]?.actions || [];
  if (mode === 'open') return { mode, actions, order: [], turnMid: null, complete: false };
  const order = waiverOrder(gwIdx);
  if (mode === 'ordered') {
    return { mode, order, actions, turnMid: order[actions.length] ?? null, complete: actions.length >= order.length };
  }
  // redraft: keep cycling the order until a full lap of passes
  const lap = actions.slice(-order.length);
  const complete = actions.length >= order.length && lap.every(a => a.pass);
  return { mode, order, actions, turnMid: complete ? null : order[actions.length % order.length], complete };
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
  if (!force && !canActFor(mid)) { toast(`It's ${managerName(mid)}'s pick — Moggi is watching you`); return; }
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
      if (whoami === mid) state.view = 'team';
      pushShared('phase', 'season');
      toast('Draft complete. Moggi has filed the paperwork. Game on.');
    } else if (Math.random() < 0.3) {
      toast(moggiSays());
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
  const best = PLAYERS.filter(p => !taken.has(p.id) && canPick(mid, p))
    .sort((a, b) => rating(b) - rating(a))[0];
  if (best) makePick(best.id, force);
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
// auto-subs: starters who never played are replaced by bench players who did,
// best-rated first, keeping the XI shape legal
function effectiveXI(mid, gwIdx) {
  const xi = [...lineupFor(mid, gwIdx)];
  const ev = gwEvent(gwIdx);
  const anySynced = !!ev && Object.keys(ev.playerStats || {}).length > 0;
  if (!anySynced) return { xi, subs: [] };
  const squad = squadAt(mid, gwIdx);
  const bench = squad.filter(p => !xi.includes(p.id) && appearedInGw(p.id, gwIdx))
    .sort((a, b) => rating(b) - rating(a));
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
  return effectiveXI(mid, gwIdx).xi.reduce((t, pid) => t + gwPlayerPoints(pid, gwIdx), 0);
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

/* ---------------- head-to-head ---------------- */
function gwStatus(i) {
  const ev = gwEvent(i);
  const synced = !!ev && Object.keys(ev.playerStats || {}).length > 0;
  if (synced && (ev.final || gwIsOver(i))) return 'final';
  if (synced) return 'live';
  if (gwHasStarted(i)) return 'underway';
  return 'upcoming';
}
function h2hStandings() {
  const rows = Object.fromEntries(state.managers.map(m => [m.id, { id: m.id, name: m.name, team: m.team, p: 0, w: 0, d: 0, l: 0, pts: 0 }]));
  for (let i = 0; i < REGULAR_GWS; i++) {
    if (gwStatus(i) !== 'final') continue;
    for (const [a, b] of pairingsFor(i)) {
      const pa = gwManagerPoints(a, i), pb = gwManagerPoints(b, i);
      rows[a].p++; rows[b].p++;
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

async function syncNow(manual = false) {
  if (demoMode) { if (manual) toast('Demo mode — the results are fictional, like Moggi’s innocence'); return; }
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
    state.fixtures = fixtures
      .filter(f => f.date)
      .sort((a, b) => a.date.localeCompare(b.date));
    let fresh = 0;
    for (const [gwN, gw] of Object.entries(stats.gws || {})) {
      const i = +gwN - 1;
      if (!GAMEWEEKS[i]) continue;
      const key = `gw${gwN}`;
      const before = JSON.stringify(state.matchStats[key]?.playerStats || {}).length;
      state.matchStats[key] = {
        gw: i,
        label: GAMEWEEKS[i].label,
        date: GAMEWEEKS[i].from,
        final: !!gw.finished,
        playerStats: gw.stats || {},
      };
      if (JSON.stringify(gw.stats || {}).length !== before) fresh++;
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

/* ---------------- views ---------------- */
const NAV_ITEMS = [
  ['draft', 'The Console'],
  ['team', 'My Team'],
  ['h2h', 'Head-to-Head'],
  ['cup', 'The Monzo Cup'],
  ['table', 'League Table'],
  ['fixtures', 'Fixtures'],
  ['rules', 'Rules'],
  ['settings', 'Settings'],
];

function render() {
  // keep keyboard focus across re-renders (remote updates land mid-typing)
  const ae = document.activeElement;
  const focusId = ae && ae.id && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT') ? ae.id : null;
  let caret = null;
  try { caret = focusId && ae.selectionStart != null ? ae.selectionStart : null; } catch { caret = null; }

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
    case 'h2h': main.innerHTML = viewH2H(); break;
    case 'cup': main.innerHTML = viewCup(); break;
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

function renderIdentity() {
  let ov = $('#whoOverlay');
  const needed = netOn() && state.phase !== 'setup' && !whoami;
  if (!needed) { ov?.remove(); return; }
  if (ov) return;
  ov = document.createElement('div');
  ov.id = 'whoOverlay';
  ov.className = 'overlay';
  ov.innerHTML = `<div class="card" style="max-width:420px;width:92%">
    <h2>Who are you?</h2>
    <p class="muted" style="font-size:13px;margin-bottom:14px">Actions from this device count for the manager you pick. Choose honestly — Moggi has your number. Literally.</p>
    ${state.managers.map((m, i) => `<button class="btn ghost" data-who="${m.id}" style="width:100%;margin-bottom:8px;text-align:left">${esc(m.name)}${i === 0 ? ' <span class="tag">commissioner</span>' : ''}</button>`).join('')}
    <button class="btn ghost" data-who="-1" style="width:100%;opacity:.7">Just watching</button>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelectorAll('[data-who]').forEach(b => b.onclick = () => {
    whoami = +b.dataset.who;
    localStorage.setItem(WHO_KEY, whoami);
    render();
    toast(whoami === -1 ? 'Spectator mode. Probably a journalist.' : `Welcome, ${managerName(whoami)}. This conversation is being recorded.`);
  });
}

function renderNav() {
  const nav = $('#nav');
  if (state.phase === 'setup') { nav.innerHTML = ''; return; }
  nav.innerHTML = NAV_ITEMS.map(([id, label]) =>
    `<button data-view="${id}" class="${state.view === id ? 'active' : ''}">${label}</button>`).join('');
  nav.querySelectorAll('button').forEach(b => b.onclick = () => { state.view = b.dataset.view; save(); render(); });
}

function renderSyncArea() {
  const el = $('#syncArea');
  if (!el || state.phase === 'setup') { if (el) el.innerHTML = ''; return; }
  const bits = [];
  if (anyMatchLive()) bits.push('<span class="live-pill"><span class="rec"></span>LIVE</span>');
  if (syncOn()) {
    bits.push(`<span class="conn ${syncConnected ? 'up' : ''}" title="${syncConnected ? 'Live sync: connected' : 'Live sync: reconnecting — changes will queue'}">&#9679;</span>`);
    const who = whoami === -1 ? 'Spectating' : (whoami ? esc(managerName(whoami)) : 'Who are you?');
    bits.push(`<button class="tag" id="whoBtn" style="cursor:pointer" title="Switch who this device acts as">${who}</button>`);
  }
  if (state.phase === 'season') {
    const last = state.lastSync ? new Date(state.lastSync).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never';
    bits.push(`<span>Last intercept: ${last}</span><button id="syncBtn" class="btn small">&#128222; Tap the lines</button>`);
  }
  bits.push(`<button class="tag" id="muteBtn" style="cursor:pointer" title="Broadcast sound (Iain's mute button)">${soundOn() ? '&#128266;' : '&#128263;'}</button>`);
  el.innerHTML = bits.join('');
  const mb = $('#muteBtn');
  if (mb) mb.onclick = () => {
    localStorage.setItem('tl2627-mute', soundOn() ? '1' : '0');
    renderSyncArea();
    toast(soundOn() ? 'Broadcast sound on. Sorry, Iain.' : 'Broadcast muted. Iain wins this one.');
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
          ${[0, 20, 30, 45, 60].map(t => `<option value="${t}" ${state.settings.pickTimer === t ? 'selected' : ''}>${t ? t + 's — Moggi picks at zero' : 'Off'}</option>`).join('')}
        </select>
      </div>
      <div class="setup-total" id="setupTotal"></div>
    </div>
    <button class="btn" id="startDraft" style="padding:14px;font-size:16px">Randomise order &amp; start the draft</button>
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
  $('#startDraft').onclick = () => {
    if (!confirm('This starts the REAL draft for all twelve managers. Everyone ready?')) return;
    state.managers.forEach((m, i) => { if (!m.name.trim()) m.name = `Manager ${i + 1}`; });
    if (state.settings.squadSize < 11) { toast('Squads need at least 11 for a starting XI'); return; }
    const { posMin, posMax } = state.settings;
    const minSum = posMin.GK + posMin.DF + posMin.MF + posMin.FW;
    const maxSum = posMax.GK + posMax.DF + posMax.MF + posMax.FW;
    if (minSum > state.settings.squadSize || maxSum < state.settings.squadSize) { toast('Position min/max can’t make a legal squad'); return; }
    state.draft.order = state.managers.map(m => m.id).sort(() => Math.random() - 0.5);
    if (state.settings.pickTimer) state.draft.deadline = Date.now() + 5 * 60 * 1000;
    state.phase = 'draft';
    state.view = 'draft';
    publishAll();
    save(); render();
    localStorage.setItem('tl2627-ceremony-seen', state.draft.order.join('-'));
    showCeremony();
  };
}

/* ----- opening ceremony (requested by Marc, dedicated to Iain) ----- */
// each club's flag is carried by a selected legend (selection panel: Moggi)
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
    { h: '&#9917; THE OPENING CEREMONY', p: 'Live and exclusive coverage with David Prutton, alongside Big Al Brazil, who has been here since the gallops. Season twelve of The League. Iain, be upstanding. Especially you.' },
    { h: '&#127884; THE PARADE OF CLUBS', p: '', parade: true },
    { h: '&#127908; Main stage', p: 'Coldplay perform Viva la Vida in its 9-minute extended ceremony arrangement. Chris Martin has been told this is a twelve-man WhatsApp league that left its old website over £145. He says every revolution is beautiful.' },
    { h: '&#127930; The anthems', p: 'The stadium now rises for a full and unabridged rendition of North London Forever. Marc weeps openly. Iain has been located attempting to leave the venue. Stewards have returned him to his seat.', anthem: true },
    { h: '&#129309; The draw', p: 'Luciano Moggi shuffles the envelopes. The envelopes were sealed. The seals were his.' },
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
        <button class="btn ghost small" id="cerSkip" title="Reserved for Iain">Skip ceremony (Iain's button)</button>
      </div></div>`;
    if (s.parade) {
      playSound('sting');
      let f = 0;
      const nations = TEAMS;
      const showFlag = () => {
        const slot = $('#paradeSlot');
        if (!slot) { clearInterval(paradeTimer); return; }
        if (f >= nations.length) {
          slot.innerHTML = `<p class="rules-p" style="text-align:center">All ${nations.length} clubs present. Iain checked his watch ${nations.length} times.</p>`;
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
        <div style="background:var(--card2);font-size:11px;color:var(--muted);padding:6px 10px;text-align:center">Louis Dunford &mdash; The Angel (North London Forever). If your phone blocks autoplay, tap play. Iain: volume stays up.</div>`;
      $('#cerStage').appendChild(player);
    }
    $('#cerNext').onclick = () => { i++; show(); };
    $('#cerSkip').onclick = () => { ov.remove(); toast('Ceremony skipped. Iain nods, once.'); };
  };
  show();
}

/* ----- drinks breaks (mandatory, per Marc; non-negotiable, per Iain's objections) ----- */
const DRINKS_COPY = [
  'FIRST DRINKS BREAK — a third of the way. Hydrate. Moggi is having a Negroni with a man he has never officially met.',
  'SECOND DRINKS BREAK — two thirds done. Stretch the legs. Iain: this break is contractually mandatory and was added specifically because of you.',
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
 "Man City": "The 115 charges have their own Wikipedia page, several podcasts, and a defence bill bigger than most squads. Moggi calls it 'apprentice work'.",
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

/* ----- broadcast audio (synthesized, no files, Iain-mutable) ----- */
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
let poolFilter = { q: '', team: '', pos: '', sort: 'rating', limit: 60 };

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
      <div class="pick-meta">Pick ${n + 1} of ${totalPicks()} &middot; Round ${round} of ${state.settings.squadSize}</div>
      <div class="intercept"><span class="rec"></span>LIVE INTERCEPT &mdash; &ldquo;${esc(interceptFor(n, managerName(mid)))}&rdquo;</div>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      ${state.settings.pickTimer ? '<span class="pick-clock" id="pickClock">–:––</span>' : ''}
      ${state.settings.pickTimer ? `<button class="btn ghost small" id="timewasteBtn" title="Take it to the corner flag (+60s)">&#8987; Timewaste (${2 - (state.draft.timewastes?.[mid] || 0)} left)</button>` : ''}
      <button class="btn ghost small" id="undoPick" ${n === 0 ? 'disabled' : ''}>Undo last</button>
      <button class="btn ghost small" id="autoPick" title="Luciano makes a call. Untraceable, naturally.">&#128222; Ask Moggi</button>
    </div>
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
      <div class="card side-squad">
        <h2>${esc(managerName(mid))}'s squad</h2>
        <div class="quota-bar">${quotaPills(mid)}</div>
        ${managerSquad(mid).sort((a, b) => POS_ORDER[a.pos] - POS_ORDER[b.pos]).map(p => `
          <div class="srow"><span class="pos-badge pos-${p.pos}">${p.pos}</span>${kitImg(p.team, p.pos === 'GK')}<span>${esc(p.name)}</span></div>
        `).join('') || '<span class="muted">No picks yet</span>'}
      </div>
      ${punditryDesk()}
      <div class="card">
        <h2>Pick history</h2>
        <div class="pick-log">
          ${[...state.draft.picks].reverse().slice(0, 40).map(pk => {
            const p = PLAYER_BY_ID[pk.playerId];
            return `<div class="lrow"><span class="muted">#${pk.n}</span><b>${esc(managerName(pk.managerId))}</b> ${flagImg(p.team)} ${esc(p.name)}</div>`;
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
  rows.sort((a, b) => s === 'name' ? a.name.localeCompare(b.name)
    : s === 'price' ? b.price - a.price
    : rating(b) - rating(a));
  const total = rows.length;
  rows = rows.slice(0, poolFilter.limit);
  return `
  <table class="pool-table">
    <thead><tr>
      <th data-sort="name">Player</th><th>Club</th><th>Pos</th>
      <th></th>
      <th class="num" data-sort="price" title="Current FPL price">£m ${s === 'price' ? '▾' : ''}</th>
      <th class="num" data-sort="rating" title="Last season's FPL points (price until the new season's data arrives)">Pts 25/26 ${s === 'rating' ? '▾' : ''}</th><th></th>
    </tr></thead>
    <tbody>
      ${rows.map(p => `
      <tr>
        <td><div class="pcell">${photoImg(p)}<div><div class="pname">${esc(p.name)}</div><div class="pclub">${esc(p.full)}</div></div></div></td>
        <td class="muted" style="white-space:nowrap">${flagImg(p.team)} ${esc(p.club)}</td>
        <td><span class="pos-badge pos-${p.pos}">${p.pos}</span></td>
        <td>${statusChip(p)}</td>
        <td class="num">${p.price.toFixed(1)}</td>
        <td class="num gold">${rating(p)}</td>
        <td><button class="btn small" data-pick="${p.id}" ${canPick(mid, p) && canActFor(mid) ? '' : `disabled title="${canActFor(mid) ? 'Position limits hit' : `${esc(managerName(mid))} is on the clock, not you`}"`}>Draft</button></td>
      </tr>`).join('')}
    </tbody>
  </table>
  ${total > poolFilter.limit ? `<div class="show-more"><button class="btn ghost small" id="showMore">Show more (${total - poolFilter.limit} hidden)</button></div>` : ''}`;
}

let clockTimer = null;
let firedDeadline = 0;
function bindDraft() {
  clearInterval(clockTimer);
  if (state.phase === 'season') return;
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
      if (!el || state.phase !== 'draft') { clearInterval(clockTimer); return; }
      const bn = pickNo();
      const breakDue = drinksBreakAt(bn) && !(state.draft.breaksDone || []).includes(bn);
      if (breakDue || $('#drinksBreak') || $('#ceremony')) return; // clock politely waits for pomp
      const left = Math.max(0, Math.round(((state.draft.deadline || 0) - Date.now()) / 1000));
      el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      el.classList.toggle('urgent', left <= 10);
      if (left <= 0 && state.draft.deadline && firedDeadline !== state.draft.deadline) {
        firedDeadline = state.draft.deadline;
        toast('Time! Moggi makes the call.');
        autoPick(true);
      }
    }, 400);
  }
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
  $('#autoPick').onclick = autoPick;
}
function refreshPool() {
  const card = document.querySelector('.draft-layout .card');
  card.querySelector('.pool-table')?.remove();
  card.querySelector('.show-more')?.remove();
  card.insertAdjacentHTML('beforeend', poolTable());
  bindPoolTable();
  const q = $('#poolQ'); q.focus();
  q.setSelectionRange(q.value.length, q.value.length);
}
function bindPoolTable() {
  document.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => makePick(+b.dataset.pick));
  document.querySelectorAll('[data-sort]').forEach(th => th.onclick = () => { poolFilter.sort = th.dataset.sort; refreshPool(); });
  const sm = $('#showMore');
  if (sm) sm.onclick = () => { poolFilter.limit += 100; refreshPool(); };
}

function viewDraftRecap() {
  return `<div class="card"><h2>The Console &mdash; draft archive</h2>
    <p class="muted" style="margin-bottom:12px">All ${totalPicks()} picks are in. The recordings have been sealed.</p>
    <div class="pick-log" style="max-height:none">
    ${state.draft.picks.map(pk => {
      const p = PLAYER_BY_ID[pk.playerId];
      return `<div class="lrow"><span class="muted" style="width:38px">#${pk.n}</span><b style="width:130px">${esc(managerName(pk.managerId))}</b>${flagImg(p.team)} ${esc(p.name)} <span class="muted">· ${p.pos} · ${esc(p.team)}</span></div>`;
    }).join('')}
    </div></div>`;
}

/* ----- my team (lineups + transfers) ----- */
let teamView = { mid: null, gw: null, transferOut: null };

function viewTeam() {
  if (teamView.mid == null) teamView.mid = state.managers[0].id;
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
  const swapUsed = troughUsed(mid, cur);

  const countsBar = ['GK', 'DF', 'MF', 'FW'].map(pos => {
    const [lo, hi] = XI_RULES[pos];
    const ok = counts[pos] >= lo && counts[pos] <= hi;
    return `<span class="quota-pill ${ok ? 'full' : 'bad'}">${pos} ${counts[pos]} <span class="muted">(${lo}–${hi})</span></span>`;
  }).join('') + `<span class="quota-pill ${xi.length === 11 ? 'full' : 'bad'}">XI ${xi.length}/11</span>`;

  return `
  <div class="team-controls card">
    <select id="teamMgr">${state.managers.map(m => `<option value="${m.id}" ${m.id === mid ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
    <select id="teamGw">${GAMEWEEKS.map((g, i) => `<option value="${i}" ${i === gw ? 'selected' : ''}>GW${g.n} — ${g.label}${i === cur ? ' (current)' : ''}</option>`).join('')}</select>
    <span class="tag">${locked ? (gwIsOver(gw) ? 'Gameweek finished — locked' : 'Deadline passed — locked') : `Lineup open — locks ${new Date(gwFrom(gw)).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`}</span>
    <span class="tag">GW points: <b class="gold">&nbsp;${gwManagerPoints(mid, gw)}</b></span>
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
          return `<div class="squad-row lineup-row ${starting ? 'starting' : 'benched'}" data-toggle="${p.id}" ${locked ? '' : 'style="cursor:pointer"'}>
            <span class="shirt-no" data-num="${p.id}" title="Click to assign a squad number">${shirtNum(mid, p.id)}</span>
            <span class="pos-badge pos-${p.pos}">${p.pos}</span>${kitImg(p.team, p.pos === 'GK')}
            <span>${esc(p.name)} ${statusChip(p)}</span>
            <span class="muted" style="font-size:11.5px">${esc(p.club)}</span>
            <span class="sp-pts ${pts > 0 ? 'gold' : 'muted'}">${pts}</span>
            <span class="xi-chip">${starting ? 'XI' : 'bench'}</span>
          </div>`;
        }).join('')}`).join('')}
    </div>
    <div class="draft-side">
      <div class="card">
        ${(() => {
          const wv = waiverState(cur);
          const title = wv.mode === 'redraft' ? `THE JANUARY RE-DRAFT <span class="tag">bottom of the league up</span>`
            : wv.mode === 'ordered' ? `GW${GAMEWEEKS[cur].n} Waivers <span class="tag">bottom feeds first</span>`
            : `The Trough <span class="tag">GW${GAMEWEEKS[cur].n}</span>`;
          const blurb = wv.mode === 'redraft' ? 'The great replenishment: snake through the order, swap as many as you like, pass when done. Round ends after a full lap of passes.'
            : wv.mode === 'ordered' ? 'One swap each, in reverse table order. Pass if the Trough offers nothing.'
            : 'One swap per manager this gameweek — drop anyone, sign any free agent. No queue, no ceremony.';
          const chips = wv.mode === 'open'
            ? `<div class="quota-bar" style="margin-bottom:10px">${state.managers.map(m => `<span class="quota-pill ${troughUsed(m.id, cur) ? 'full' : ''}">${esc(m.name)} ${troughUsed(m.id, cur) ? '✓ fed' : '—'}</span>`).join('')}</div>`
            : `<div class="order-strip" style="margin-bottom:10px">${wv.order.map(om => `<span class="order-chip ${om === wv.turnMid ? 'now' : ''}">${esc(managerName(om))}</span>`).join('<span class="muted" style="align-self:center">›</span>')}</div>`;
          const actorMid = wv.mode === 'open' ? mid : wv.turnMid;
          let body;
          if (wv.complete) body = `<p class="muted" style="font-size:12.5px">Round complete. The Trough reopens next gameweek.</p>`;
          else if (wv.mode === 'open' && troughUsed(mid, cur)) body = `<p class="muted" style="font-size:12.5px">${esc(managerName(mid))} has fed this gameweek.</p>`;
          else if (!canActFor(actorMid)) body = `<p class="muted" style="font-size:12.5px"><b style="color:var(--text)">${esc(managerName(actorMid))}</b> is at the Trough. Lean on them in the group chat.</p>`;
          else body = `
            ${wv.mode !== 'open' ? `<p style="font-size:13px;margin-bottom:8px"><b>${esc(managerName(actorMid))}</b> is at the Trough</p>` : ''}
            <select id="trOut" style="width:100%;margin-bottom:8px">
              <option value="">Player out…</option>
              ${squadAt(actorMid, cur).sort((a, b) => POS_ORDER[a.pos] - POS_ORDER[b.pos]).map(p => `<option value="${p.id}" ${teamView.transferOut === p.id ? 'selected' : ''}>${p.pos} — ${esc(p.name)} (${esc(p.team)})</option>`).join('')}
            </select>
            <input type="text" id="trSearch" placeholder="Search the Trough — ${PLAYERS.length - ownedNow.size} players sniffing about…" style="width:100%;margin-bottom:8px">
            <div id="trResults" class="pick-log"></div>
            ${wv.mode !== 'open' ? `<button class="btn ghost small" id="trPass" style="margin-top:8px">Pass${wv.mode === 'redraft' ? ' — I\'m done feeding' : ''}</button>` : ''}`;
          return `<h2>${title}</h2><p class="muted" style="font-size:12px;margin-bottom:10px">${blurb}</p>${chips}${body}`;
        })()}
        <h3 style="margin-top:16px">Transfer log</h3>
        ${state.transfers.filter(t => t.managerId === mid).map(t =>
          `<div class="lrow" style="font-size:12.5px;padding:3px 0"><span class="muted">GW${GAMEWEEKS[t.gw].n}${t.trade ? ' ↔' : ''}</span> ${esc(PLAYER_BY_ID[t.outId].name)} <span class="muted">→</span> <b>${esc(PLAYER_BY_ID[t.inId].name)}</b></div>`).join('') || '<span class="muted" style="font-size:12.5px">None yet.</span>'}
      </div>
      <div class="card">
        <h2>Trade desk</h2>
        <p class="muted" style="font-size:12px;margin-bottom:10px">Agreed in the group? Swap one player between two squads. Doesn't use a waiver turn.</p>
        <select id="tradeWith" style="width:100%;margin-bottom:8px">
          <option value="">Trade ${esc(managerName(mid))} with…</option>
          ${state.managers.filter(m => m.id !== mid).map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}
        </select>
        <div id="tradePickers"></div>
      </div>
      <div class="card">
        <h2>Gameweek points</h2>
        ${GAMEWEEKS.map((g, i) => {
          const st = gwStatus(i);
          if (st === 'upcoming') return '';
          return `<div class="lrow" style="justify-content:space-between"><span>GW${g.n} ${g.label} ${st !== 'final' ? '<span class="rec" style="display:inline-block"></span>' : ''}</span><b>${gwManagerPoints(mid, i)}</b></div>`;
        }).join('') || '<span class="muted">Nothing played yet.</span>'}
      </div>
    </div>
  </div>`;
}

function bindTeam() {
  $('#teamMgr').onchange = e => { teamView.mid = +e.target.value; teamView.transferOut = null; render(); };
  $('#teamGw').onchange = e => { teamView.gw = +e.target.value; render(); };
  const gw = teamView.gw, mid = teamView.mid;
  if (demoMode || !gwHasStarted(gw)) {
    document.querySelectorAll('[data-toggle]').forEach(row => row.onclick = () => {
      if (!canActFor(mid)) { toast(`That's ${managerName(mid)}'s team, not yours`); return; }
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
  // --- custom squad numbers ---
  document.querySelectorAll('[data-num]').forEach(el => el.onclick = e => {
    e.stopPropagation();
    if (!canActFor(mid)) { toast(`That's ${managerName(mid)}'s squad numbering, not yours`); return; }
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
  });
  // --- the Trough / waivers / re-draft ---
  const out = $('#trOut'), search = $('#trSearch'), results = $('#trResults'), passBtn = $('#trPass');
  if (out) {
    const cur = currentGwIndex();
    const wv = waiverState(cur);
    const actorMid = wv.mode === 'open' ? mid : wv.turnMid;
    out.onchange = () => { teamView.transferOut = +out.value || null; renderTrResults(); };
    search.oninput = renderTrResults;
    if (passBtn) passBtn.onclick = () => {
      if (!canActFor(actorMid)) { toast(`It's ${managerName(actorMid)}'s turn`); return; }
      (state.waivers[cur] = state.waivers[cur] || { actions: [] }).actions.push({ mid: actorMid, pass: true });
      pushShared(`waivers/${cur}/actions`, state.waivers[cur].actions);
      teamView.transferOut = null;
      save(); render();
      toast(`${managerName(actorMid)} passes.`);
    };
    function renderTrResults() {
      const q = normName(search.value || '');
      const owned = ownedIdsAt(cur);
      const outP = teamView.transferOut ? PLAYER_BY_ID[teamView.transferOut] : null;
      const squadAfterOut = squadAt(actorMid, cur).filter(p => !outP || p.id !== outP.id);
      let pool = PLAYERS.filter(p => !owned.has(p.id));
      if (q) pool = pool.filter(p => normName(p.name).includes(q) || normName(p.team).includes(q) || normName(p.club).includes(q));
      pool.sort((a, b) => rating(b) - rating(a));
      const hint = outP ? `<div class="muted" style="font-size:11.5px;padding:2px 0 6px">Replacements for ${esc(outP.name)} (${outP.pos}):</div>`
        : '<div class="muted" style="font-size:11.5px;padding:2px 0 6px">Browsing the Trough — choose a player out above to unlock signing.</div>';
      results.innerHTML = hint + pool.slice(0, 20).map(p => {
        const ok = outP && squadShapeOk([...squadAfterOut, p]);
        const why = !outP ? 'Pick who goes out first' : 'Breaks the squad position limits';
        return `<div class="lrow"><span class="pos-badge pos-${p.pos}">${p.pos}</span>${photoImg(p)} ${esc(p.name)} ${statusChip(p)} <span class="muted" style="font-size:11px">${esc(p.club)} · ${rating(p)} pts</span>
         <button class="btn small" style="margin-left:auto" data-trin="${p.id}" ${ok ? '' : `disabled title="${why}"`}>Sign</button></div>`;
      }).join('') || '<span class="muted">The Trough is empty. Somehow.</span>';
      results.querySelectorAll('[data-trin]').forEach(b => b.onclick = () => {
        if (!canActFor(actorMid)) { toast(`It's ${managerName(actorMid)}'s turn at the Trough`); return; }
        if (wv.mode === 'open' && troughUsed(actorMid, cur)) { toast('Swap already used this gameweek'); return; }
        const inId = +b.dataset.trin, outId = teamView.transferOut;
        const inP = PLAYER_BY_ID[inId];
        if (!squadShapeOk([...squadAt(actorMid, cur).filter(x => x.id !== outId), inP])) { toast('Breaks the squad position limits'); return; }
        state.transfers.push({ managerId: actorMid, outId, inId, gw: cur, n: state.transfers.length + 1 });
        (state.waivers[cur] = state.waivers[cur] || { actions: [] }).actions.push({ mid: actorMid, outId, inId });
        const lu = state.lineups[actorMid]?.[cur];
        if (lu) state.lineups[actorMid][cur] = lu.filter(id => id !== outId);
        pushShared('transfers', state.transfers);
        pushShared(`waivers/${cur}/actions`, state.waivers[cur].actions);
        if (state.lineups[actorMid]?.[cur]) pushShared(`lineups/${actorMid}/${cur}`, state.lineups[actorMid][cur]);
        teamView.transferOut = null;
        save(); render();
        toast(`${inP.name} signed from the Trough. Moggi handled the paperwork.`);
      });
    }
    renderTrResults();
  }
  // --- trade desk ---
  const tradeWith = $('#tradeWith'), pickers = $('#tradePickers');
  if (tradeWith) {
    tradeWith.onchange = () => {
      const other = +tradeWith.value;
      if (!other) { pickers.innerHTML = ''; return; }
      const cur = currentGwIndex();
      const mine = squadAt(mid, cur).sort((a, b) => POS_ORDER[a.pos] - POS_ORDER[b.pos]);
      const theirs = squadAt(other, cur).sort((a, b) => POS_ORDER[a.pos] - POS_ORDER[b.pos]);
      pickers.innerHTML = `
        <select id="tradeMine" style="width:100%;margin-bottom:8px">
          <option value="">${esc(managerName(mid))} gives…</option>
          ${mine.map(p => `<option value="${p.id}">${p.pos} — ${esc(p.name)} (${esc(p.team)})</option>`).join('')}
        </select>
        <select id="tradeTheirs" style="width:100%;margin-bottom:8px">
          <option value="">${esc(managerName(other))} gives…</option>
          ${theirs.map(p => `<option value="${p.id}">${p.pos} — ${esc(p.name)} (${esc(p.team)})</option>`).join('')}
        </select>
        <button class="btn small" id="tradeGo">Execute trade</button>`;
      $('#tradeGo').onclick = () => {
        if (!canActFor(mid) && !canActFor(other)) { toast('You are not part of this trade'); return; }
        const a = +$('#tradeMine').value, b = +$('#tradeTheirs').value;
        if (!a || !b) { toast('Pick a player from each side'); return; }
        const pa = PLAYER_BY_ID[a], pb = PLAYER_BY_ID[b];
        if (!squadShapeOk([...squadAt(mid, cur).filter(p => p.id !== a), pb]) ||
            !squadShapeOk([...squadAt(other, cur).filter(p => p.id !== b), pa])) {
          toast('Trade breaks a squad\'s position limits'); return;
        }
        state.transfers.push({ managerId: mid, outId: a, inId: b, gw: cur, n: state.transfers.length + 1, trade: true });
        state.transfers.push({ managerId: other, outId: b, inId: a, gw: cur, n: state.transfers.length + 1, trade: true });
        for (const [m2, gone] of [[mid, a], [other, b]]) {
          const lu = state.lineups[m2]?.[cur];
          if (lu) {
            state.lineups[m2][cur] = lu.filter(id => id !== gone);
            pushShared(`lineups/${m2}/${cur}`, state.lineups[m2][cur]);
          }
        }
        pushShared('transfers', state.transfers);
        save(); render();
        toast(`Trade done: ${pa.name} ↔ ${pb.name}. Nobody saw anything.`);
      };
    };
  }
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
function viewH2H() {
  const standings = h2hStandings();
  const anyFinal = standings.some(r => r.p > 0);
  const cur = currentGwIndex();
  return `
  <div class="card" style="margin-bottom:18px">
    <h2>Head-to-Head table <span class="muted" style="font-weight:400;font-size:12px">win 3 &middot; draw 1 &middot; loss 0 &middot; tiebreak: overall points &middot; regular season = GW1–33</span></h2>
    <table class="pool-table">
      <thead><tr><th></th><th>Team</th><th class="num">P</th><th class="num">W</th><th class="num">D</th><th class="num">L</th><th class="num">Pts</th><th class="num">Overall</th></tr></thead>
      <tbody>
      ${standings.map((r, i) => `
        <tr class="${i === 3 ? 'playoff-line' : ''}">
          <td class="muted">${i + 1}</td>
          <td><b>${esc(r.team || r.name)}</b> <span class="muted" style="font-size:11px">${esc(r.name)}</span> ${anyFinal && i === 0 ? '&#127942;' : ''}</td>
          <td class="num">${r.p}</td><td class="num">${r.w}</td><td class="num">${r.d}</td><td class="num">${r.l}</td>
          <td class="num gold">${r.pts}</td>
          <td class="num muted">${managerPoints(r.id)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <p class="muted" style="font-size:11px;margin-top:6px">Top four make the playoffs.</p>
  </div>
  ${playoffCard()}
  ${GAMEWEEKS.slice(0, REGULAR_GWS).map((g, i) => {
    const st = gwStatus(i);
    if (st === 'upcoming' && i > cur + 2) return ''; // don't render 30 empty future cards
    const tag = st === 'final' ? '<span class="tag">FT</span>'
      : st === 'live' ? '<span class="tag live-tag"><span class="rec"></span>LIVE</span>'
      : st === 'underway' ? '<span class="tag">underway — tap the lines</span>'
      : '<span class="tag">upcoming</span>';
    return `
    <div class="card" style="margin-bottom:12px">
      <h2 style="display:flex;align-items:center;gap:10px">GW${g.n} ${tag}</h2>
      ${pairingsFor(i).map(([a, b]) => {
        const pa = st === 'upcoming' ? '–' : gwManagerPoints(a, i);
        const pb = st === 'upcoming' ? '–' : gwManagerPoints(b, i);
        const aWin = st === 'final' && pa > pb, bWin = st === 'final' && pb > pa;
        return `<div class="h2h-fx">
          <span class="${aWin ? 'h2h-win' : ''}" style="flex:1;text-align:right">${esc(teamName(a))}</span>
          <span class="fx-score">${pa} &ndash; ${pb}</span>
          <span class="${bWin ? 'h2h-win' : ''}" style="flex:1">${esc(teamName(b))}</span>
        </div>`;
      }).join('')}
    </div>`;
  }).join('')}`;
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
    </div>`).join('')}`;
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
      const moggiTag = !hasPts ? '' :
        i === 0 ? '<span class="tag" title="Calciopoli, Article 6">&#128269; under investigation</span>' :
        i === ranked.length - 1 ? '<span class="tag">&#11015;&#65039; Serie B awaits</span>' : '';
      return `
      <div class="league-row ${i === 0 && m.pts > 0 ? 'leader' : ''}" data-mgr-row="${m.id}" style="cursor:pointer">
        <span class="rank">${i + 1}</span>
        <span class="lname">${esc(m.team || m.name)} <span class="muted" style="font-size:11.5px;font-weight:400">${esc(m.name)}</span> ${i === 0 && m.pts > 0 ? '&#127942;' : ''} ${moggiTag}</span>
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
  ['2024–25', 'Richard Blank', '*'], ['2025–26', 'TBC', ''],
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
      <p class="rules-p"><b>Auto-subs:</b> if a starter doesn't play at all that gameweek, your best bench player who did play comes in automatically.</p>
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
      <p class="rules-p"><b>Weekly waivers:</b> one swap each, taken in reverse table order — bottom feeds first. Pass if the Trough offers nothing.</p>
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
      <p class="rules-p muted" style="font-style:italic">All decisions are final. Especially the pre-arranged ones. — L. Moggi</p>
    </div>
  </div>`;
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
  </div>`;
}
function bindSettings() {
  document.querySelectorAll('[data-score]').forEach(inp => inp.onchange = () => {
    if (netOn() && !isCommissioner()) { toast('Only the commissioner changes scoring'); render(); return; }
    state.settings.scoring[inp.dataset.score] = +inp.value || 0;
    pushShared(`settings/scoring/${inp.dataset.score}`, state.settings.scoring[inp.dataset.score]);
    save(); toast('Scoring updated');
  });
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
      if (netOn()) window.WCSync.setRoot(null);
      save(); render();
    }
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

/* ---------------- boot ---------------- */
render();
// auto-sync on load during the tournament (max once per 20 min, always if live)
if (state.phase === 'season') {
  const stale = !state.lastSync || (Date.now() - new Date(state.lastSync).getTime()) > 20 * 60 * 1000;
  if (stale || anyMatchLive()) syncNow(false);
}

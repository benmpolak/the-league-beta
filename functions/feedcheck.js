/* Strict validation of the published reference feed (pure JSON only).
 *
 * The server refuses to execute anything it fetches: data/data.json,
 * data/history25.json and data/stats.json are parsed as data and validated
 * for shape, type and size before use. A feed that fails any check is
 * rejected outright — better a refused mutation than a poisoned server.
 * Shared by functions/index.js and the offline test suite (test/feed.test.js).
 */
'use strict';

const LIMITS = {
  dataBytes: 3 * 1024 * 1024,
  statsBytes: 20 * 1024 * 1024,
  historyBytes: 8 * 1024 * 1024,
  teams: 40,
  players: 2500,
  gameweeks: 60,
  statPlayersPerGw: 2500,
  fixturesPerPlayer: 6,
  historyPlayers: 5000,
};

const POS = new Set(['GK', 'DF', 'MF', 'FW']);
const byteLen = s => (typeof Buffer !== 'undefined' ? Buffer.byteLength(s, 'utf8') : s.length);

function fail(msg) {
  const e = new Error(`feed rejected: ${msg}`);
  e.feedRejected = true;
  throw e;
}
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isInt = v => Number.isInteger(v);
const isIso = v => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

function parseJson(text, label, maxBytes) {
  if (typeof text !== 'string') fail(`${label}: not text`);
  if (byteLen(text) > maxBytes) fail(`${label}: oversized (${byteLen(text)} > ${maxBytes} bytes)`);
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label}: not valid JSON`);
  }
}

/* data/data.json — { generated, teams, players, gameweeks } */
function validateData(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) fail('data.json: not an object');
  const { teams, players, gameweeks } = d;
  if (!Array.isArray(teams) || teams.length < 1 || teams.length > LIMITS.teams) fail('data.json: teams');
  for (const t of teams) {
    if (!t || typeof t !== 'object' || !isInt(t.id) || !isStr(t.name || '', 60)) fail('data.json: team entry');
  }
  if (!Array.isArray(players) || players.length < 1 || players.length > LIMITS.players) fail('data.json: players');
  const seen = new Set();
  for (const p of players) {
    if (!p || typeof p !== 'object') fail('data.json: player entry');
    if (!isInt(p.id) || p.id < 0 || p.id > 99999999) fail(`data.json: player id ${p.id}`);
    if (seen.has(p.id)) fail(`data.json: duplicate player id ${p.id}`);
    seen.add(p.id);
    if (!POS.has(p.pos)) fail(`data.json: player pos ${p.pos}`);
    if (!isStr(p.name || '', 80) || !isStr(p.full || '', 120) || !isStr(p.club || '', 60)) fail('data.json: player strings');
    if (p.team != null && !isNum(p.team) && !isStr(p.team, 60)) fail('data.json: player team');
    if (!isStr(p.status || '', 3) || !isStr(p.news || '', 400) || !isStr(p.newsAdded || '', 40)) fail('data.json: player news fields');
    if (p.chance != null && !isNum(p.chance)) fail('data.json: player chance');
    if (p.code != null && !isInt(p.code)) fail('data.json: player code');
    for (const k of ['price', 'pts', 'rating', 'xp', 'ppg', 'mp', 'g', 'a', 'cs', 'xg', 'xa']) {
      if (p[k] != null && !isNum(p[k])) fail(`data.json: player ${k}`);
    }
  }
  if (!Array.isArray(gameweeks) || gameweeks.length < 1 || gameweeks.length > LIMITS.gameweeks) fail('data.json: gameweeks');
  for (const g of gameweeks) {
    if (!g || typeof g !== 'object' || !isInt(g.n) || !isStr(g.label || '', 20)) fail('data.json: gameweek entry');
    if (!isIso(g.deadline)) fail(`data.json: gameweek ${g.n} deadline`);
    if (g.to != null && !isIso(g.to)) fail(`data.json: gameweek ${g.n} to`);
    if (g.finished != null && typeof g.finished !== 'boolean') fail(`data.json: gameweek ${g.n} finished`);
  }
  return { TEAMS: teams, PLAYERS: players, GAMEWEEKS_RAW: gameweeks };
}

/* data/stats.json — { generated, currentGw, gws: { "<n>": { finished, stats: { "<pid>": row } } } }
 * rows are numeric fields plus an optional all-numeric fx array (double gameweeks) */
function validateStats(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) fail('stats.json: not an object');
  if (s.generated != null && !isIso(s.generated)) fail('stats.json: generated');
  if (s.currentGw != null && !isInt(s.currentGw)) fail('stats.json: currentGw');
  const gws = s.gws || {};
  if (typeof gws !== 'object' || Array.isArray(gws)) fail('stats.json: gws');
  const entries = Object.entries(gws);
  if (entries.length > LIMITS.gameweeks) fail('stats.json: gameweek count');
  for (const [k, gw] of entries) {
    if (!/^\d{1,2}$/.test(k)) fail(`stats.json: gw key ${k}`);
    if (!gw || typeof gw !== 'object' || Array.isArray(gw)) fail(`stats.json: gw ${k} entry`);
    if (gw.finished != null && typeof gw.finished !== 'boolean') fail(`stats.json: gw ${k} finished`);
    const st = gw.stats || {};
    if (typeof st !== 'object' || Array.isArray(st)) fail(`stats.json: gw ${k} stats`);
    const rows = Object.entries(st);
    if (rows.length > LIMITS.statPlayersPerGw) fail(`stats.json: gw ${k} player count`);
    for (const [pid, row] of rows) {
      if (!/^\d{1,8}$/.test(pid)) fail(`stats.json: player key ${pid}`);
      if (!row || typeof row !== 'object' || Array.isArray(row)) fail(`stats.json: row ${pid}`);
      for (const [f, v] of Object.entries(row)) {
        if (f === 'fx') {
          if (!Array.isArray(v) || v.length > LIMITS.fixturesPerPlayer) fail(`stats.json: fx for ${pid}`);
          for (const m of v) {
            if (!m || typeof m !== 'object' || Array.isArray(m)) fail(`stats.json: fx row for ${pid}`);
            for (const fv of Object.values(m)) if (!isNum(fv)) fail(`stats.json: fx value for ${pid}`);
          }
        } else if (!isNum(v)) {
          fail(`stats.json: field ${f} for ${pid}`);
        }
      }
    }
  }
  return s;
}

/* data/history25.json — { season, byCode: { "<code>": { ...archive row } } } */
function validateHistory(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) fail('history25.json: not an object');
  const byCode = h.byCode || {};
  if (typeof byCode !== 'object' || Array.isArray(byCode)) fail('history25.json: byCode');
  const rows = Object.entries(byCode);
  if (rows.length > LIMITS.historyPlayers) fail('history25.json: size');
  for (const [code, row] of rows) {
    if (!/^\d{1,9}$/.test(code)) fail(`history25.json: code ${code}`);
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail(`history25.json: row ${code}`);
    for (const v of Object.values(row)) {
      const t = typeof v;
      if (t !== 'number' && !(t === 'string' && v.length <= 120)) fail(`history25.json: value under ${code}`);
    }
  }
  return { byCode };
}

module.exports = { LIMITS, parseJson, validateData, validateStats, validateHistory };

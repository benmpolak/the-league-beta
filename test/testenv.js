/* Shared harness for the emulator suites (rules + functions).
 * Everything runs against the Firebase emulators — never live. The reference
 * data (players/gameweeks/stats) is synthetic, generated around "now" so the
 * gameweek clock has a past GW, a live GW and future GWs to exercise. */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));

const PROJECT = 'calciopoli-wc26';
const NS = `${PROJECT}-default-rtdb`;
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const FN_BASE = `http://127.0.0.1:5001/${PROJECT}/europe-west1`;
const DATA_PORT = 8126;

if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST;
if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) process.env.FIREBASE_DATABASE_EMULATOR_HOST = DB_HOST;

/* ---- synthetic reference data ---- */
function genTestData() {
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const gws = [];
  for (let n = 1; n <= 6; n++) {
    // GW1 finished, GW2 live (started 2h ago), rest in the future
    const deadline = n === 1 ? iso(now - 4 * 864e5) : n === 2 ? iso(now - 2 * 3600e3) : iso(now + (n - 2) * 864e5);
    const to = n === 1 ? iso(now - 2 * 864e5) : n === 2 ? iso(now + 20 * 3600e3) : iso(now + (n - 1) * 864e5);
    gws.push({ n, label: `GW${n}`, deadline, to, finished: n === 1 });
  }
  const clubs = ['Arsenal', 'Everton', 'Spurs'];
  const players = [];
  let id = 100;
  // pool comfortably exceeds 3 full squads (6 GK / 15 DF / 12 MF / 9 FW used)
  // so every position has free agents left in the Trough
  for (const [pos, count] of [['GK', 8], ['DF', 18], ['MF', 16], ['FW', 12]]) {
    for (let i = 0; i < count; i++) {
      players.push({
        id: id, name: `${pos}${i}`, full: `Test ${pos}${i}`, team: (id % 3) + 1, club: clubs[id % 3],
        pos, code: 9000 + id, status: 'a', news: '', price: 50, pts: 0,
        rating: 200 - (id - 100), xp: 3, ppg: 4, mp: 30, g: 2, a: 1, cs: 3, xg: 1.2, xa: 0.8,
      });
      id++;
    }
  }
  const teams = clubs.map((name, i) => ({ id: i + 1, name, short: name.slice(0, 3).toUpperCase(), code: i + 1, str: 1200 }));
  // GW1 stats: everyone in the first half of each position band played and scored a bit
  const gw1stats = {};
  for (const p of players) {
    if (p.id % 2 === 0) gw1stats[p.id] = { min: 90, g: p.pos === 'FW' ? 1 : 0, a: p.pos === 'MF' ? 1 : 0, cs: p.pos !== 'FW' ? 1 : 0, gc: 0, sv: p.pos === 'GK' ? 4 : 0 };
  }
  const dir = path.join(ROOT, 'test', 'fixtures', 'testdata');
  fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'js', 'data.js'),
    `const TEAMS = ${JSON.stringify(teams)};\nconst PLAYERS = ${JSON.stringify(players)};\nconst GAMEWEEKS_RAW = ${JSON.stringify(gws)};\n`);
  fs.writeFileSync(path.join(dir, 'js', 'history25.js'), 'const LAST_SEASON = {season: "test", byCode: {}};\n');
  // the server consumes ONLY the pure-JSON feed (it never executes fetched JS)
  fs.writeFileSync(path.join(dir, 'data', 'data.json'),
    JSON.stringify({ generated: new Date().toISOString(), teams, players, gameweeks: gws }));
  fs.writeFileSync(path.join(dir, 'data', 'history25.json'),
    JSON.stringify({ season: 'test', byCode: {} }));
  fs.writeFileSync(path.join(dir, 'data', 'stats.json'),
    JSON.stringify({ generated: new Date().toISOString(), currentGw: 2, gws: { 1: { finished: true, stats: gw1stats }, 2: { finished: false, stats: {} } } }));
  fs.writeFileSync(path.join(dir, 'data', 'fixtures.json'), '[]');
  return { players, gws, dir };
}

function serveTestData(dir) {
  const server = http.createServer((req, res) => {
    const p = path.join(dir, req.url.split('?')[0]);
    if (!p.startsWith(dir) || !fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': p.endsWith('.json') ? 'application/json' : 'text/javascript' });
    res.end(fs.readFileSync(p));
  });
  return new Promise(resolve => server.listen(DATA_PORT, '127.0.0.1', () => resolve(server)));
}

/* ---- admin + users ---- */
function initAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: PROJECT, databaseURL: `https://${NS}.europe-west1.firebasedatabase.app` });
  }
  return admin;
}
async function wipe() {
  await initAdmin().database().ref('/').set(null);
  // clear all emulator auth users
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
}
async function provision(league, members) {
  const a = initAdmin();
  const out = {};
  for (const m of members) {
    const user = await a.auth().createUser({ email: m.email, emailVerified: true });
    const role = m.role || 'manager';
    await a.auth().setCustomUserClaims(user.uid, { leagues: { [league]: { managerId: m.managerId, role } } });
    await a.database().ref(`v2/leagues/${league}/server/membership/${user.uid}`).set({ managerId: m.managerId, role });
    await a.database().ref(`v2/leagues/${league}/server/managerUid/${m.managerId}`).set(user.uid);
    out[m.managerId] = { uid: user.uid, email: m.email };
  }
  return out;
}
async function idTokenFor(uid) {
  const custom = await initAdmin().auth().createCustomToken(uid);
  const r = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: custom, returnSecureToken: true }),
  });
  const j = await r.json();
  if (!j.idToken) throw new Error(`no idToken: ${JSON.stringify(j)}`);
  return j.idToken;
}
/* email-link sign-in against the auth emulator: request the oob code, read it
 * back from the emulator's inbox endpoint, complete the link */
async function emailLinkSignIn(email) {
  await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=fake`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestType: 'EMAIL_SIGNIN', email, continueUrl: 'http://localhost/league' }),
  });
  const inbox = await (await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/oobCodes`)).json();
  const code = [...(inbox.oobCodes || [])].reverse().find(c => c.email === email && c.requestType === 'EMAIL_SIGNIN');
  if (!code) throw new Error('no oob code for ' + email);
  const r = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithEmailLink?key=fake`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, oobCode: code.oobCode }),
  });
  return r.json(); // {idToken, email, ...} or {error}
}

/* ---- clients ---- */
async function call(name, body, idToken) {
  const r = await fetch(`${FN_BASE}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify({ data: body }),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, result: j.result, error: j.error };
}
const mutate = (league, action, data, idToken) => call('mutate', { league, action, data }, idToken);

// raw REST against the DB emulator AS A CLIENT (rules enforced unless bearer owner)
async function rest(method, dbPath, { token, body, owner } = {}) {
  const url = `http://${DB_HOST}/${dbPath}.json?ns=${NS}${token ? `&auth=${token}` : ''}`;
  const r = await fetch(url, {
    method,
    headers: owner ? { Authorization: 'Bearer owner' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let val = null;
  try { val = await r.json(); } catch { /* empty */ }
  return { status: r.status, val };
}

/* ---- league seeding ---- */
// a legal mini-league: every manager has a full 14-squad drafted by snake from
// the synthetic pool; settings are the real defaults
function buildSeedState(players, managerCount = 3) {
  const managers = Array.from({ length: managerCount }, (_, i) => ({ id: i + 1, name: `M${i + 1}`, team: `Team ${i + 1}` }));
  const order = managers.map(m => m.id);
  const byPos = pos => players.filter(p => p.pos === pos).map(p => p.id);
  const pools = { GK: byPos('GK'), DF: byPos('DF'), MF: byPos('MF'), FW: byPos('FW') };
  const picks = [];
  // deal each manager 2 GK / 5 DF / 4 MF / 3 FW = 14, legal under default bounds
  const deal = { GK: 2, DF: 5, MF: 4, FW: 3 };
  for (const m of managers) {
    for (const [pos, n] of Object.entries(deal)) {
      for (let k = 0; k < n; k++) picks.push({ managerId: m.id, playerId: pools[pos].shift(), n: picks.length + 1 });
    }
  }
  return {
    phase: 'season',
    managers,
    settings: {
      squadSize: 14,
      posMin: { GK: 1, DF: 3, MF: 3, FW: 1 },
      posMax: { GK: 2, DF: 6, MF: 6, FW: 4 },
      pickTimer: 30,
      scoring: {
        appearance: 1, appearance60: 2, goalGK: 10, goalDF: 6, goalMF: 5, goalFW: 4,
        assist: 3, cleanSheet: 4, cleanSheetMF: 1, per3Saves: 1, penSave: 5,
        penMiss: -2, yellow: -1, red: -3, ownGoal: -2, per2Conceded: -1,
      },
    },
    draft: { order, picks, breaksDone: [], timewastes: {}, paused: false, pausedLeft: 0 },
    lineups: {}, transfers: [], trades: [], covenants: [], claims: {}, autolists: {},
    waiverMeta: { lastRun: null, control: 'auto' },
    draftPool: { at: Date.now(), ids: Object.fromEntries(players.map(p => [p.id, p.club])) },
    windowDraft: null, tradeBlock: {}, benchOrders: {}, lobus: {}, hamCup: null, adjustments: {}, shirtNums: {},
  };
}

/* ---- tiny check runner ---- */
function makeRunner(suiteName) {
  let pass = 0, fail = 0;
  return {
    chk(name, ok, detail = '') {
      if (ok) pass++;
      else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`); }
      if (ok && process.env.VERBOSE) console.log(`PASS  ${name}`);
    },
    done() {
      console.log(`\n[${suiteName}] ${pass} passed, ${fail} failed`);
      process.exit(fail ? 1 : 0);
    },
  };
}

module.exports = {
  PROJECT, NS, AUTH_HOST, DB_HOST, FN_BASE, DATA_PORT,
  genTestData, serveTestData, initAdmin, wipe, provision, idTokenFor, emailLinkSignIn,
  call, mutate, rest, buildSeedState, makeRunner,
};

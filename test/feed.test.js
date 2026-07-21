/* The server's feed validation (functions/feedcheck.js), unit-tested offline:
 * well-formed feeds pass; malformed, mistyped and oversized feeds are
 * rejected with a hard error before anything touches the game engine. */
'use strict';
const path = require('path');
const Feed = require(path.join(__dirname, '..', 'functions', 'feedcheck.js'));

let pass = 0, fail = 0;
const chk = (name, ok, detail = '') => {
  if (ok) pass++; else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};
const rejects = (name, fn, wants = 'feed rejected') => {
  try { fn(); chk(name, false, 'no error thrown'); }
  catch (e) { chk(name, String(e.message).includes(wants), e.message); }
};

const goodPlayer = (id, pos = 'MF') => ({
  id, name: `P${id}`, full: `Player ${id}`, club: 'Everton', team: 2, pos,
  code: 9000 + id, price: 50, pts: 10, rating: 100, xp: 3, ppg: 4, mp: 30, g: 1, a: 1, cs: 0, xg: 0.5, xa: 0.5,
});
const goodData = () => ({
  generated: '2026-07-21T12:00:00Z',
  teams: [{ id: 1, name: 'Everton', short: 'EVE', code: 2, str: 1200 }],
  players: [goodPlayer(1, 'GK'), goodPlayer(2, 'DF'), goodPlayer(3)],
  gameweeks: [{ n: 1, label: 'GW1', deadline: '2026-08-15T17:30:00Z', to: '2026-08-17T17:30:00Z', finished: false }],
});
const goodStats = () => ({
  generated: '2026-07-21T12:00:00Z', currentGw: 1,
  gws: { 1: { finished: false, stats: { 1: { min: 90, g: 1, a: 0 }, 2: { min: 45, fx: [{ min: 45, g: 0 }, { min: 0 }] } } } },
});

/* ---- happy paths ---- */
chk('valid data.json accepted', !!Feed.validateData(goodData()).PLAYERS);
chk('valid stats.json accepted', !!Feed.validateStats(goodStats()));
chk('valid history accepted', !!Feed.validateHistory({ season: 'x', byCode: { 123: { pts: 35, club: 'EVE' } } }));
chk('parseJson round-trips', Feed.parseJson('{"a":1}', 't', 100).a === 1);

/* ---- size caps ---- */
rejects('oversized payload rejected', () => Feed.parseJson('x'.repeat(200), 't', 100), 'oversized');
rejects('non-JSON rejected', () => Feed.parseJson('const PLAYERS = [1];', 'data.json', 1000), 'not valid JSON');
rejects('JS code as feed rejected', () => Feed.parseJson('(function(){return 1})()', 'data.json', 1000), 'not valid JSON');

/* ---- data.json shape ---- */
rejects('data: not an object', () => Feed.validateData([1, 2]));
rejects('data: missing players', () => Feed.validateData({ ...goodData(), players: [] }));
rejects('data: too many players', () => {
  const d = goodData();
  d.players = Array.from({ length: Feed.LIMITS.players + 1 }, (_, i) => goodPlayer(i + 1));
  Feed.validateData(d);
});
rejects('data: duplicate player id', () => {
  const d = goodData(); d.players[1] = { ...d.players[1], id: 1 }; Feed.validateData(d);
});
rejects('data: bad position', () => {
  const d = goodData(); d.players[0] = { ...d.players[0], pos: 'XX' }; Feed.validateData(d);
});
rejects('data: non-numeric stat', () => {
  const d = goodData(); d.players[0] = { ...d.players[0], pts: 'lots' }; Feed.validateData(d);
});
rejects('data: absurd player name', () => {
  const d = goodData(); d.players[0] = { ...d.players[0], name: 'x'.repeat(500) }; Feed.validateData(d);
});
rejects('data: gameweek without parseable deadline', () => {
  const d = goodData(); d.gameweeks[0] = { ...d.gameweeks[0], deadline: 'whenever' }; Feed.validateData(d);
});
rejects('data: gameweeks not an array', () => Feed.validateData({ ...goodData(), gameweeks: {} }));

/* ---- stats.json shape ---- */
rejects('stats: not an object', () => Feed.validateStats('nope'));
rejects('stats: non-numeric gw key', () => Feed.validateStats({ gws: { evil: { stats: {} } } }));
rejects('stats: non-numeric field', () => Feed.validateStats({ gws: { 1: { stats: { 5: { min: 'ninety' } } } } }));
rejects('stats: string smuggled in fx', () => Feed.validateStats({ gws: { 1: { stats: { 5: { min: 90, fx: [{ g: 'alert(1)' }] } } } } }));
rejects('stats: fx too long', () => Feed.validateStats({ gws: { 1: { stats: { 5: { min: 90, fx: Array(10).fill({ g: 0 }) } } } } }));
rejects('stats: bad player key', () => Feed.validateStats({ gws: { 1: { stats: { '__proto__x': { min: 1 } } } } }));

/* ---- history shape ---- */
rejects('history: array rejected', () => Feed.validateHistory([1]));
rejects('history: bad code key', () => Feed.validateHistory({ byCode: { 'not-a-code': { pts: 1 } } }));
rejects('history: nested object value rejected', () => Feed.validateHistory({ byCode: { 5: { pts: { evil: true } } } }));
rejects('history: oversized string value rejected', () => Feed.validateHistory({ byCode: { 5: { club: 'x'.repeat(500) } } }));

/* ---- the real published feed passes its own validation ---- */
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const realData = fs.readFileSync(path.join(ROOT, 'data', 'data.json'), 'utf8');
const realStats = fs.readFileSync(path.join(ROOT, 'data', 'stats.json'), 'utf8');
const realHist = fs.readFileSync(path.join(ROOT, 'data', 'history25.json'), 'utf8');
chk('published data.json validates', !!Feed.validateData(Feed.parseJson(realData, 'data.json', Feed.LIMITS.dataBytes)));
chk('published stats.json validates', !!Feed.validateStats(Feed.parseJson(realStats, 'stats.json', Feed.LIMITS.statsBytes)));
chk('published history25.json validates', !!Feed.validateHistory(Feed.parseJson(realHist, 'history25.json', Feed.LIMITS.historyBytes)));

console.log(`\n[feed] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

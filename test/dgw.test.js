// Double-gameweek scoring: real GW26 (25/26) players who played twice. Proves
// the per-fixture scoring is right, that the old aggregate scoring was wrong,
// and that ordinary single-fixture players are unaffected.
// Usage: python3 -m http.server 8125 (repo root) then node test/dgw.test.js
const puppeteer = require('puppeteer-core');
const chromePath = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let failures = 0;
const check = (l, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${d ? ' — ' + d : ''}`); if (!ok) failures++; };

// real per-fixture data pulled from the FPL API's `explain` for GW26 (a DGW).
// expected = correct league points under the default table (GK goal 10 / DF 6 /
// MF 5 / FW 4, assist 3, CS 4/4/1/0, -1 per 2 conceded GK/DF, saves per 3,
// yellow -1, appearance: START 2 / SUB 1 — the Committee's Jul 2026 ruling,
// no 60-minute threshold; st = number of starts in the GW).
// oldAgg = what the buggy aggregate scoring gave.
const CASES = [
  { name: 'Raya', pos: 'GK', expected: 3, oldAgg: 1,
    stats: { min: 180, st: 2, gc: 3, sv: 2, fx: [{ min: 90 }, { min: 90, gc: 2 }] } },
  { name: 'Gabriel', pos: 'DF', expected: 5, oldAgg: 3,
    stats: { min: 180, st: 2, a: 1, gc: 3, yc: 1, fx: [{ min: 90, yc: 1 }, { min: 90, a: 1, gc: 2 }] } },
  { name: 'Saka', pos: 'MF', expected: 8, oldAgg: 7,
    stats: { min: 92, st: 1, g: 1, gc: 2, fx: [{ min: 20 }, { min: 72, g: 1 }] } },
  { name: 'Gyokeres', pos: 'FW', expected: 3, oldAgg: 1,
    stats: { min: 154, st: 2, yc: 1, fx: [{ min: 90, yc: 1 }, { min: 64 }] } },
];
// an ordinary single-fixture defender who kept a clean sheet — must be unchanged
const SINGLE = { name: 'single-GW DF', pos: 'DF', expected: 6, stats: { min: 90, st: 1, cs: 1 } };
// the Committee's rule, pinned: a 30-minute STARTER earns the full 2 (the old
// 60-minute rule paid 1); a 70-minute SUB earns 1 (the old rule paid 2)
const START_RULE = [
  { name: 'starter hooked at 30 min gets 2', pos: 'MF', expected: 2, stats: { min: 30, st: 1 } },
  { name: '70-minute sub gets 1', pos: 'MF', expected: 1, stats: { min: 70, st: 0, sub: 1 } },
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
  });
  const p = await browser.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:8125?nosync', { waitUntil: 'networkidle2' });

  // ensure default scoring is in force
  await p.evaluate(() => { state.settings.scoring = { ...DEFAULT_SCORING }; });

  for (const c of CASES) {
    const r = await p.evaluate(c => {
      const withFx = statPoints({ pos: c.pos }, c.stats);
      const noFx = { ...c.stats }; delete noFx.fx;
      const aggregate = statPoints({ pos: c.pos }, noFx);
      return { withFx, aggregate };
    }, c);
    check(`DGW ${c.name} (${c.pos}) scores ${c.expected} per fixture, not ${c.oldAgg}`,
      r.withFx === c.expected && r.aggregate === c.oldAgg, `got ${r.withFx} (aggregate would be ${r.aggregate})`);
  }

  const s = await p.evaluate(c => statPoints({ pos: c.pos }, c.stats), SINGLE);
  check('single-fixture scoring unchanged (no fx field)', s === SINGLE.expected, `got ${s}`);

  for (const c of START_RULE) {
    const r = await p.evaluate(c => statPoints({ pos: c.pos }, c.stats), c);
    check(c.name, r === c.expected, `got ${r}`);
  }

  check('zero page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await browser.close();
  console.log(failures ? `\n${failures} FAILURES` : '\nDGW SCORING CORRECT — every match counts');
  process.exit(failures ? 1 : 0);
})();

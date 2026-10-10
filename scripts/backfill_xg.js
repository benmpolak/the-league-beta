#!/usr/bin/env node
/* Reconstruct per-gameweek xG, xA and xGC for rounds that have already gone.
 *
 * Marc, 10 Oct 2026: "Fumdamentally i want to see if a players high xg is in
 * one game or many, is recent, or was ages ago."
 *
 * He cannot, because the feed only ever gave us one season-to-date number per
 * player. data/stats.json keeps minutes, goals, assists and the rest round by
 * round, but the xG family arrives as a running total and the running total is
 * all we stored, so every window would show the same figure.
 *
 * Nothing can hand those rounds back per-gameweek now. But the FPL refresh bot
 * commits data/data.json every few minutes, so the running total at the end of
 * each round is still sitting in this repo's history — 3,396 commits of it.
 * Difference two snapshots and you have the round in between.
 *
 * The baseline is clean: FPL wipes every player to zero at the first deadline
 * of the season. Checked, not assumed — 2026-08-21 17:00 still had Haaland on
 * last season's 25.5, an hour later the whole feed read 0.
 *
 * Only settled rounds are touched, and a round already carrying xG is left
 * alone, so running this twice is a no-op rather than a hazard.
 *
 *   node scripts/backfill_xg.js --dry    print what would be written
 *   node scripts/backfill_xg.js          write data/stats.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'data.json');
const OUT = path.join(ROOT, 'data', 'stats.json');
const DRY = process.argv.includes('--dry');
// what we reconstruct. xGI is not stored — the app adds xG and xA itself, and
// a third number that can disagree with its own inputs is how the xGI column
// got into trouble in the first place (Marc, 24 Aug 2026).
const FIELDS = ['xg', 'xa', 'xgc'];

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// The last commit at or before `when`: the round's matches are long played and
// its bonus and corrections have landed, while the next round has not kicked
// off, because `to` IS the next deadline.
function commitAt(when) {
  const out = git('log', '--format=%H %cI', '--until', when, '-1', '--', 'data/data.json').trim();
  if (!out) return null;
  const [sha, iso] = out.split(' ');
  return { sha, iso };
}

function snapshotAt(when) {
  const c = commitAt(when);
  if (!c) return null;
  let feed;
  try {
    feed = JSON.parse(git('show', `${c.sha}:data/data.json`));
  } catch {
    return null;                       // a commit that predates the file
  }
  const by = new Map();
  for (const p of feed.players || []) {
    by.set(String(p.id), Object.fromEntries(FIELDS.map(f => [f, +p[f] || 0])));
  }
  return { ...c, by, players: by.size };
}

function main() {
  const feed = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const book = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const gws = (feed.gameweeks || []).filter(g => g.finished && book.gws?.[g.n]);
  if (!gws.length) {
    console.log('no settled round has stats to attach xG to — nothing to do');
    return;
  }

  // Cumulative at the FIRST deadline is the nought: FPL has just wiped.
  let prev = new Map();
  let wrote = 0, skipped = 0;
  const report = [];

  for (const g of gws) {
    const row = book.gws[g.n];
    const already = Object.values(row.stats || {}).some(r => FIELDS.some(f => r[f] != null));
    const shot = snapshotAt(g.to);
    if (!shot) {
      report.push(`  GW${g.n}  no snapshot in history at ${g.to} — skipped`);
      skipped++;
      continue;
    }
    if (already) {
      report.push(`  GW${g.n}  already carries xG — left alone`);
      prev = shot.by;                  // still needed as the next round's base
      skipped++;
      continue;
    }

    let touched = 0, missing = 0, negatives = 0;
    let totals = Object.fromEntries(FIELDS.map(f => [f, 0]));
    for (const [pid, stat] of Object.entries(row.stats || {})) {
      const now = shot.by.get(pid);
      if (!now) { missing++; continue; } // signed after this round, or left the feed
      const was = prev.get(pid) || Object.fromEntries(FIELDS.map(f => [f, 0]));
      for (const f of FIELDS) {
        const d = now[f] - was[f];
        // FPL revises xG after the fact, so a difference can come out slightly
        // under nought. That is a correction to an earlier round, not negative
        // expected goals: floor it and move on.
        if (d < -0.005) negatives++;
        const v = Math.max(0, Math.round(d * 100) / 100);
        if (v > 0) stat[f] = v;
        totals[f] += v;
      }
      touched++;
    }
    wrote++;
    report.push(`  GW${g.n}  ${String(touched).padStart(3)} players`
      + `   xG ${totals.xg.toFixed(1).padStart(6)}  xA ${totals.xa.toFixed(1).padStart(6)}  xGC ${totals.xgc.toFixed(1).padStart(6)}`
      + `   [${shot.sha.slice(0, 8)} ${shot.iso}]`
      + (missing ? `  (${missing} not in that snapshot)` : '')
      + (negatives ? `  (${negatives} revised down)` : ''));
    prev = shot.by;
  }

  console.log(`${DRY ? 'WOULD WRITE' : 'WRITING'} per-gameweek xG, xA and xGC\n`);
  console.log(report.join('\n'));

  // Does it add up? The rounds must sum to the season total the feed is
  // showing right now, give or take the rounds we could not reach.
  const season = new Map();
  for (const p of feed.players || []) season.set(String(p.id), p);
  let worst = null;
  for (const [pid, p] of season) {
    if (!(+p.xg)) continue;
    let sum = 0;
    for (const g of gws) sum += book.gws[g.n]?.stats?.[pid]?.xg || 0;
    const gap = Math.abs(sum - (+p.xg || 0));
    if (!worst || gap > worst.gap) worst = { name: p.full || p.name, gap, sum, season: +p.xg };
  }
  if (worst) {
    console.log(`\n  biggest gap between the rounds and the season total: ${worst.name}`
      + ` — rounds ${worst.sum.toFixed(2)}, feed ${worst.season.toFixed(2)} (${worst.gap.toFixed(2)} out)`);
    console.log('  a gap here is the round in play, which has no settled stats yet.');
  }

  // A worked example beats a summary: show one forward's season broken up.
  const show = [...season.values()].sort((a, b) => (+b.xg || 0) - (+a.xg || 0))[0];
  if (show) {
    const line = gws.map(g => {
      const v = book.gws[g.n]?.stats?.[String(show.id)]?.xg;
      return `GW${g.n} ${v == null ? '—' : v.toFixed(2)}`;
    }).join('  ');
    console.log(`\n  ${show.full || show.name}, season xG ${(+show.xg).toFixed(2)}:\n    ${line}`);
  }

  if (DRY) { console.log(`\n(dry run — ${wrote} rounds would be written, ${skipped} skipped)`); return; }
  fs.writeFileSync(OUT, JSON.stringify(book) + '\n');
  console.log(`\nwrote ${wrote} rounds into data/stats.json (${skipped} skipped)`);
}

main();

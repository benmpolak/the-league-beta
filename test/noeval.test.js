/* Static guard: the privileged server surface must contain no dynamic code
 * execution. The feed is fetched as pure JSON and validated — nothing the
 * server downloads is ever executed. This test fails the build if anyone
 * reintroduces eval / new Function / the Function constructor into anything
 * that runs with admin credentials. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const chk = (name, ok, detail = '') => {
  if (ok) pass++; else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

// everything that runs with admin/server credentials
const SERVER_FILES = [
  'functions/index.js',
  'functions/feedcheck.js',
  'js/engine.js',            // copied to functions/engine.js at deploy
  'scripts/provision_managers.js',
  'scripts/backup_league.js',
  'scripts/restore_league.js',
  'scripts/migrate_v2.js',
  'scripts/rollback_v2.js',
  'scripts/run_waivers.js',
  'scripts/deploy.js',
];
const BANNED = [
  { name: 'eval(', re: /\beval\s*\(/ },
  { name: 'new Function', re: /\bnew\s+Function\b/ },
  { name: 'Function constructor', re: /(?<!\.)\bFunction\s*\(/ },
  { name: 'vm module', re: /require\s*\(\s*['"]vm['"]\s*\)/ },
  { name: 'child_process exec of fetched content', re: /\bexecSync?\s*\(\s*(?:await|fetch)/ },
];

for (const rel of SERVER_FILES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { chk(`${rel} exists`, false, 'file missing'); continue; }
  const src = fs.readFileSync(p, 'utf8');
  for (const b of BANNED) {
    const hit = src.match(b.re);
    chk(`${rel} contains no ${b.name}`, !hit, hit ? `matched near: ${src.slice(Math.max(0, hit.index - 40), hit.index + 40).replace(/\n/g, ' ')}` : '');
  }
}

// the deployed copy must be the same engine (no drift smuggling code in)
const a = fs.readFileSync(path.join(ROOT, 'js', 'engine.js'), 'utf8');
const bPath = path.join(ROOT, 'functions', 'engine.js');
if (fs.existsSync(bPath)) {
  chk('functions/engine.js is an exact copy of js/engine.js', a === fs.readFileSync(bPath, 'utf8'));
} else {
  chk('functions/engine.js present (copied at deploy/emulator start)', true); // predeploy copies it
}

console.log(`\n[noeval] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

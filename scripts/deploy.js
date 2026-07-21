#!/usr/bin/env node
/* Guarded deploys. There is exactly one way to deploy each thing, each names
 * its config file explicitly, and each shows you what it is about to do and
 * makes you type a mode-specific word. No file copying, no ambient defaults,
 * no "which rules file did that just pick?".
 *
 *   node scripts/deploy.js cutover-rules    -> database.rules.v2.json  (FREEZES legacy writes)
 *   node scripts/deploy.js legacy-rules     -> database.rules.json     (rollback: re-opens legacy)
 *   node scripts/deploy.js functions        -> Cloud Functions (mutate + waiverTick)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = 'calciopoli-wc26';

const MODES = {
  'cutover-rules': {
    config: 'firebase.cutover.json',
    rules: 'database.rules.v2.json',
    only: 'database',
    confirm: 'CUTOVER',
    warning: 'This deploys the v2 rules. From the moment it lands, ALL legacy writes fail:\n'
      + 'the old client goes read-only and the World Cup game is frozen. One-way door\n'
      + '(the way back is `node scripts/deploy.js legacy-rules`).',
  },
  'legacy-rules': {
    config: 'firebase.rollback-legacy.json',
    rules: 'database.rules.json',
    only: 'database',
    confirm: 'ROLLBACK',
    warning: 'This redeploys the LEGACY rules — the open, trust-the-browser world. Only do\n'
      + 'this as step 1 of the rollback procedure in MIGRATION-RUNBOOK.md.',
  },
  functions: {
    config: 'firebase.json',
    rules: null,
    only: 'functions',
    confirm: 'DEPLOY-FUNCTIONS',
    warning: 'This deploys the mutation layer and the scheduled waiver runner. Requires the\n'
      + 'Blaze plan. Safe to re-run; it replaces the running functions.',
  },
};

const mode = process.argv[2];
if (!MODES[mode]) {
  console.error(`usage: node scripts/deploy.js <${Object.keys(MODES).join('|')}>`);
  process.exit(1);
}
const m = MODES[mode];
const configPath = path.join(ROOT, m.config);
if (!fs.existsSync(configPath)) {
  console.error(`config missing: ${m.config}`);
  process.exit(1);
}
// the config must point at exactly the rules file this mode promises — a
// drifted config is a hard stop, not a silent surprise
if (m.rules) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (cfg.database?.rules !== m.rules) {
    console.error(`REFUSING: ${m.config} names "${cfg.database?.rules}" but this mode deploys "${m.rules}".`);
    process.exit(1);
  }
  const rulesPath = path.join(ROOT, m.rules);
  if (!fs.existsSync(rulesPath)) { console.error(`rules file missing: ${m.rules}`); process.exit(1); }
  const body = fs.readFileSync(rulesPath, 'utf8');
  const sha = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
  console.log(`project:  ${PROJECT}`);
  console.log(`config:   ${m.config}`);
  console.log(`rules:    ${m.rules} (${body.length} bytes, sha256 ${sha})`);
} else {
  console.log(`project:  ${PROJECT}`);
  console.log(`config:   ${m.config}`);
  console.log('target:   Cloud Functions (source: functions/)');
}
console.log(`\n${m.warning}\n`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question(`Type ${m.confirm} to proceed: `, answer => {
  rl.close();
  if (answer.trim() !== m.confirm) {
    console.error('aborted — nothing deployed');
    process.exit(1);
  }
  const args = ['--yes', 'firebase-tools', 'deploy', '--only', m.only, '--config', m.config, '--project', PROJECT];
  console.log(`\n> npx ${args.join(' ')}\n`);
  const res = spawnSync('npx', args, { cwd: ROOT, stdio: 'inherit' });
  process.exit(res.status ?? 1);
});

#!/usr/bin/env node
/* Roll the migration back: restore the legacy league node from a backup file,
 * then (optionally) delete the v2 node. Admin SDK only — plain REST is refused.
 *
 *   Against the emulator:  FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000 \
 *                          node scripts/rollback_v2.js data/backups/league.json
 *   Against live:          GOOGLE_APPLICATION_CREDENTIALS=service-account.json \
 *                          node scripts/rollback_v2.js data/backups/league.json --live
 *
 * You will be asked to type RESTORE (legacy restore) and DELETE-V2 (v2 removal).
 * Remember: rules must be rolled back FIRST or the restored legacy node stays
 * read-only — see MIGRATION-RUNBOOK.md.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const DB_URL = 'https://calciopoli-wc26-default-rtdb.europe-west1.firebasedatabase.app';
const PROJECT_ID = 'calciopoli-wc26';

const LIVE = process.argv.includes('--live');
const emu = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
if (!LIVE && !emu) {
  console.error('Refusing: no emulator env set and --live not given.');
  process.exit(1);
}
if (LIVE && emu) {
  console.error('Refusing: --live given but FIREBASE_DATABASE_EMULATOR_HOST is set. Pick one.');
  process.exit(1);
}
if (LIVE && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('Refusing: --live requires GOOGLE_APPLICATION_CREDENTIALS. Plain REST is not supported.');
  process.exit(1);
}

const argv = process.argv.slice(2).filter(a => a !== '--live');
let league = 'the-league-2627';
let backupPath = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--league') league = argv[++i];
  else if (!backupPath) backupPath = argv[i];
  else { console.error(`unknown argument: ${argv[i]}`); process.exit(1); }
}
if (!backupPath) {
  console.error('usage: node scripts/rollback_v2.js <backup.json> [--league the-league-2627] [--live]');
  process.exit(1);
}
backupPath = path.resolve(backupPath);
if (!fs.existsSync(backupPath)) {
  console.error(`no backup at ${backupPath}`);
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
if (data == null) {
  console.error('backup is null — refusing to wipe the league with it');
  process.exit(1);
}

const ask = q => new Promise(res => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, ans => { rl.close(); res(ans.trim()); });
});

(async () => {
  const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));
  admin.initializeApp({ projectId: PROJECT_ID, databaseURL: DB_URL });
  const db = admin.database();

  const keys = typeof data === 'object' ? Object.keys(data).sort().join(', ') : typeof data;
  console.log(`Target: ${LIVE ? 'LIVE' : 'emulator'}`);
  console.log(`About to OVERWRITE leagues/${league} with ${backupPath}`);
  console.log(`Backup contains: ${keys}`);
  if (await ask('Type RESTORE to proceed: ') !== 'RESTORE') {
    console.error('aborted — nothing written');
    process.exit(1);
  }
  await db.ref(`leagues/${league}`).set(data);
  console.log(`leagues/${league} restored.`);

  const ans = await ask(`Also DELETE v2/leagues/${league}? Type DELETE-V2 to delete, anything else keeps it: `);
  if (ans === 'DELETE-V2') {
    await db.ref(`v2/leagues/${league}`).remove();
    console.log(`v2/leagues/${league} deleted.`);
  } else {
    console.log(`v2/leagues/${league} kept.`);
  }
  console.log('Done. If rules were not rolled back yet, do that now or the legacy node stays frozen.');
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });

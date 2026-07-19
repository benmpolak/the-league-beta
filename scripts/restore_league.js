#!/usr/bin/env node
// Restore the league state to Firebase from a snapshot.
//
//     node scripts/restore_league.js                          # latest legacy snapshot
//     node scripts/restore_league.js data/backups/league-v2.json
//     node scripts/restore_league.js /path/to/downloaded/league.json
//
// Same auth model as backup_league.js: exactly one of
// GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_DATABASE_EMULATOR_HOST.
// A file named *v2* restores to v2/leagues/<league>; anything else restores
// to the legacy leagues/<league> path. Asks for confirmation, then overwrites
// the target node. Every device picks the restored state up on its next sync.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');

function requireAdmin() {
  try {
    return require('firebase-admin');
  } catch {
    return require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));
  }
}

const DB_URL = 'https://calciopoli-wc26-default-rtdb.europe-west1.firebasedatabase.app';
const LEAGUE = 'the-league-2627';
const DEFAULT = path.join(ROOT, 'data', 'backups', 'league.json');

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a); }));
}

async function main() {
  const creds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const emu = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!creds && !emu) {
    console.error('ERROR: set GOOGLE_APPLICATION_CREDENTIALS (service-account file) or '
      + 'FIREBASE_DATABASE_EMULATOR_HOST — anonymous access is gone.');
    process.exit(1);
  }
  if (creds && emu) {
    console.error('ERROR: both GOOGLE_APPLICATION_CREDENTIALS and FIREBASE_DATABASE_EMULATOR_HOST '
      + 'are set — ambiguous target. Unset one.');
    process.exit(1);
  }

  const src = path.resolve(process.argv[2] || DEFAULT);
  if (!fs.existsSync(src)) {
    console.error(`no snapshot at ${src}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(src, 'utf8').trim();
  if (!raw) {
    console.error('snapshot is empty — refusing to wipe the league with it');
    process.exit(1);
  }
  const data = JSON.parse(raw);
  if (data === null || (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0)) {
    console.error('snapshot is null/empty — refusing to wipe the league with it');
    process.exit(1);
  }

  // v2 backups go to the v2 tree; everything else is the legacy tree
  const isV2 = /v2/i.test(path.basename(src));
  const dbPath = isV2 ? `v2/leagues/${LEAGUE}` : `leagues/${LEAGUE}`;
  const keys = typeof data === 'object' && !Array.isArray(data)
    ? Object.keys(data).sort().join(', ') : typeof data;

  console.log(emu ? `target: emulator at ${emu}` : 'target: live RTDB (service account)');
  console.log(`About to OVERWRITE "${dbPath}" with ${src}`);
  console.log(`Snapshot contains: ${keys}`);
  if ((await ask('Type RESTORE to proceed: ')).trim() !== 'RESTORE') {
    console.error('aborted');
    process.exit(1);
  }

  const admin = requireAdmin();
  const app = admin.initializeApp({ projectId: 'calciopoli-wc26', databaseURL: DB_URL });
  await admin.database(app).ref(dbPath).set(data);
  await app.delete();
  console.log('restored. Tell the lads to refresh.');
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });

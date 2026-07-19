#!/usr/bin/env node
// Snapshot the live league state from Firebase into the repo.
//
// Runs hourly via .github/workflows/backup.yml. Authenticated: requires either
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json   (real DB)
//   FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000                 (emulator)
// Exactly one of the two — with neither we can't read; with both it's
// ambiguous which database you meant, so we refuse rather than guess.
//
// Backs up BOTH schemas while they coexist:
//   leagues/the-league-2627     -> data/backups/league.json      (legacy)
//   v2/leagues/the-league-2627  -> data/backups/league-v2.json   (incl. private+server)
// The v2 snapshot contains manager-private data — it must stay private
// (Actions artifact), never committed to the public repo.
//
// Wipe protection (per file): if the previous snapshot was substantial and the
// database suddenly returns null/tiny content, the snapshot is NOT overwritten —
// the incident is recorded in ALERT.txt instead. Restoring is one command:
//
//     node scripts/restore_league.js                       # latest legacy snapshot
//     node scripts/restore_league.js data/backups/league-v2.json

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function requireAdmin() {
  try {
    return require('firebase-admin');
  } catch {
    // local runs borrow the copy already installed for Cloud Functions;
    // CI does a plain `npm i firebase-admin --no-save` instead
    return require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));
  }
}

const DB_URL = 'https://calciopoli-wc26-default-rtdb.europe-west1.firebasedatabase.app';
const LEAGUE = 'the-league-2627';
const OUT_DIR = process.env.LEAGUE_BACKUP_DIR || path.join(ROOT, 'data', 'backups');
const ALERT = path.join(OUT_DIR, 'ALERT.txt');

const TARGETS = [
  { dbPath: `leagues/${LEAGUE}`, file: path.join(OUT_DIR, 'league.json'), label: 'legacy' },
  { dbPath: `v2/leagues/${LEAGUE}`, file: path.join(OUT_DIR, 'league-v2.json'), label: 'v2' },
];

// recursively sort object keys so snapshots diff meaningfully
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  }
  return v;
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
  console.log(emu ? `target: emulator at ${emu}` : 'target: live RTDB (service account)');

  const admin = requireAdmin();
  const app = admin.initializeApp({ projectId: 'calciopoli-wc26', databaseURL: DB_URL });
  const db = admin.database(app);
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const alerts = [];
  for (const t of TARGETS) {
    const snap = await db.ref(t.dbPath).once('value');
    const data = snap.val();
    const out = JSON.stringify(sortKeys(data), null, 1);
    const newSize = Buffer.byteLength(out, 'utf8');
    const oldSize = fs.existsSync(t.file) ? fs.statSync(t.file).size : 0;

    // a live league shrinking to (nearly) nothing is a wipe, not an update
    if (oldSize > 2000 && (data === null || newSize < oldSize * 0.1)) {
      alerts.push(
        `${stamp}: refused to overwrite ${path.basename(t.file)} (${t.dbPath}) — database returned `
        + `${newSize} bytes vs ${oldSize} in the last snapshot.\n`
        + `If this wipe was intentional (league reset), delete ${path.basename(t.file)} `
        + `and this file, then re-run. If not: node scripts/restore_league.js\n`);
      console.log(`ALERT [${t.label}]: DB shrank ${oldSize} -> ${newSize} bytes; snapshot preserved`);
      continue;
    }
    fs.writeFileSync(t.file, out);
    console.log(`ok [${t.label}]: snapshot ${newSize} bytes at ${stamp}`);
  }

  if (alerts.length) {
    fs.writeFileSync(ALERT, alerts.join(''));
  } else if (fs.existsSync(ALERT)) {
    fs.unlinkSync(ALERT);
  }
  await app.delete();
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });

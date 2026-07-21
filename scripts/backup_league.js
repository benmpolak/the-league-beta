#!/usr/bin/env node
// Snapshot the league state from Firebase, with validation that actually
// proves something.
//
// Runs hourly via .github/workflows/backup.yml. Authenticated: requires either
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json   (real DB)
//   FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000                 (emulator)
// Exactly one of the two — with neither we can't read; with both it's
// ambiguous which database you meant, so we refuse rather than guess.
//
// Backs up BOTH schemas while they coexist:
//   leagues/the-league-2627     -> league.json      (legacy)
//   v2/leagues/the-league-2627  -> league-v2.json   (incl. private+server)
// plus manifest.json: per-target byte sizes and key counts, used by the NEXT
// run for shrink detection. The v2 snapshot contains manager-private data —
// it is encrypted in CI before upload and must never be committed.
//
// Validation (per target, all failures exit 1 so CI goes red):
//   - intrinsic schema: a non-null snapshot must look like its schema
//     (legacy: phase + managers; v2: public.phase + public.managers when
//     public exists)
//   - shrink detection against the PREVIOUS run: pass the prior artifact's
//     directory as PREV_BACKUP_DIR (CI downloads it first). A substantial
//     league that suddenly comes back null/tiny is a wipe, not an update —
//     the run fails and writes nothing for that target. Local runs fall back
//     to comparing against the existing output file, which only works where
//     state persists between runs (i.e. NOT on a fresh CI runner).

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
const LEAGUE = process.env.LEAGUE_KEY || 'the-league-2627';
const OUT_DIR = process.env.LEAGUE_BACKUP_DIR || path.join(ROOT, 'data', 'backups');
const PREV_DIR = process.env.PREV_BACKUP_DIR || null;

const TARGETS = [
  { key: 'legacy', dbPath: `leagues/${LEAGUE}`, file: 'league.json' },
  { key: 'v2', dbPath: `v2/leagues/${LEAGUE}`, file: 'league-v2.json' },
];

// recursively sort object keys so snapshots diff meaningfully
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  }
  return v;
}

const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
const count = v => (v == null ? 0 : Array.isArray(v) ? v.length : isObj(v) ? Object.keys(v).length : 1);

/* required-schema check: null is a legal snapshot (pre-cutover trees are
 * empty), but a NON-null snapshot must be recognisably its schema */
function validateShape(key, data) {
  if (data === null) return [];
  const errs = [];
  if (!isObj(data)) return [`${key}: snapshot is not an object`];
  if (key === 'legacy') {
    if (typeof data.phase !== 'string') errs.push('legacy: missing phase');
    if (count(data.managers) < 2) errs.push('legacy: missing managers');
  } else {
    const known = Object.keys(data).filter(k => ['public', 'private', 'server'].includes(k));
    if (!known.length) errs.push('v2: none of public/private/server present');
    if (data.public !== undefined && data.public !== null) {
      if (!isObj(data.public)) errs.push('v2: public is not an object');
      else {
        if (typeof data.public.phase !== 'string') errs.push('v2: public.phase missing');
        if (count(data.public.managers) < 2) errs.push('v2: public.managers missing');
      }
    }
  }
  return errs;
}

function manifestEntry(data, bytes) {
  const top = {};
  if (isObj(data)) for (const k of Object.keys(data)) top[k] = count(data[k]);
  return { present: data !== null, bytes, topCounts: top };
}

function readPrevManifest() {
  for (const dir of [PREV_DIR, OUT_DIR]) {
    if (!dir) continue;
    const p = path.join(dir, 'manifest.json');
    if (fs.existsSync(p)) {
      try { return { from: p, manifest: JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch { /* corrupt prev — ignore */ }
    }
  }
  return null;
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

  const prev = readPrevManifest();
  console.log(prev ? `previous manifest: ${prev.from}` : 'previous manifest: none (first run or artifact expired)');

  const admin = requireAdmin();
  const app = admin.initializeApp({ projectId: 'calciopoli-wc26', databaseURL: DB_URL });
  const db = admin.database(app);
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const failures = [];
  const manifest = { stamp, league: LEAGUE, targets: {} };
  for (const t of TARGETS) {
    const snap = await db.ref(t.dbPath).once('value');
    const data = snap.val();
    const out = JSON.stringify(sortKeys(data), null, 1);
    const newBytes = Buffer.byteLength(out, 'utf8');

    const shapeErrs = validateShape(t.key, data);
    if (shapeErrs.length) {
      failures.push(`${t.key}: snapshot failed schema validation — ${shapeErrs.join('; ')}`);
      continue;
    }

    const prevEntry = prev?.manifest?.targets?.[t.key];
    if (prevEntry && prevEntry.present && prevEntry.bytes > 2000
      && (data === null || newBytes < prevEntry.bytes * 0.1)) {
      failures.push(`${t.key}: database shrank ${prevEntry.bytes} -> ${newBytes} bytes since the last `
        + 'successful backup — refusing to record it. If this was an intentional reset, '
        + 'run once with ALLOW_SHRINK=1.');
      continue;
    }

    fs.writeFileSync(path.join(OUT_DIR, t.file), out);
    manifest.targets[t.key] = manifestEntry(data, newBytes);
    console.log(`ok [${t.key}]: snapshot ${newBytes} bytes at ${stamp}`);
  }

  if (failures.length && process.env.ALLOW_SHRINK === '1') {
    console.log('ALLOW_SHRINK=1 — recording anyway:');
    for (const t of TARGETS) {
      if (manifest.targets[t.key]) continue;
      const snap = await db.ref(t.dbPath).once('value');
      const out = JSON.stringify(sortKeys(snap.val()), null, 1);
      fs.writeFileSync(path.join(OUT_DIR, t.file), out);
      manifest.targets[t.key] = manifestEntry(snap.val(), Buffer.byteLength(out, 'utf8'));
    }
    failures.length = 0;
  }

  await app.delete();
  if (failures.length) {
    for (const f of failures) console.error(`BACKUP FAILED — ${f}`);
    process.exit(1);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log('manifest written');
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });

#!/usr/bin/env node
// Restore league state to Firebase from a snapshot file. Nothing is inferred
// from the filename: you say which schema and which league, explicitly.
//
//     node scripts/restore_league.js <snapshot.json> --schema legacy --league the-league-2627
//     node scripts/restore_league.js <snapshot.json> --schema v2 --league the-league-2627
//
// Flags:
//   --schema legacy|v2   REQUIRED. legacy restores to leagues/<league>,
//                        v2 restores to v2/leagues/<league>.
//   --league <key>       REQUIRED. e.g. the-league-2627 / the-league-sandbox.
//   --yes                skip the interactive confirmation (tests/automation).
//
// Same auth model as backup_league.js: exactly one of
// GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_DATABASE_EMULATOR_HOST.
// The snapshot must be recognisably the schema you declared — a v2 file
// pointed at legacy (or vice versa) is refused, as are null/empty/corrupt
// snapshots. CI v2 artifacts are encrypted; decrypt before restoring:
//   openssl enc -d -aes-256-cbc -pbkdf2 -in league-v2.json.enc -out league-v2.json

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

function usage(msg) {
  if (msg) console.error(`ERROR: ${msg}`);
  console.error('usage: node scripts/restore_league.js <snapshot.json> --schema legacy|v2 --league <key> [--yes]');
  process.exit(1);
}

function parseArgs(argv) {
  const out = { file: null, schema: null, league: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--schema') out.schema = argv[++i];
    else if (a === '--league') out.league = argv[++i];
    else if (a === '--yes') out.yes = true;
    else if (!a.startsWith('--') && !out.file) out.file = a;
    else usage(`unknown argument ${a}`);
  }
  return out;
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a); }));
}

const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);

// the declared schema must match what is actually in the file
function checkSchema(schema, data) {
  if (!isObj(data)) return 'snapshot is not an object';
  const looksV2 = ['public', 'private', 'server'].some(k => k in data);
  const looksLegacy = 'phase' in data && 'managers' in data;
  if (schema === 'v2') {
    if (!looksV2) return looksLegacy
      ? 'this looks like a LEGACY snapshot (top-level phase/managers) — you said --schema v2'
      : 'not a v2 snapshot (no public/private/server)';
    if (data.public != null && (!isObj(data.public) || typeof data.public.phase !== 'string')) {
      return 'v2 snapshot has a malformed public node';
    }
  } else {
    if (looksV2) return 'this looks like a V2 snapshot (public/private/server) — you said --schema legacy';
    if (!looksLegacy) return 'not a legacy snapshot (no phase/managers)';
  }
  return null;
}

async function main() {
  const creds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const emu = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!creds && !emu) usage('set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_DATABASE_EMULATOR_HOST');
  if (creds && emu) usage('both GOOGLE_APPLICATION_CREDENTIALS and FIREBASE_DATABASE_EMULATOR_HOST set — ambiguous target');

  const args = parseArgs(process.argv.slice(2));
  if (!args.file) usage('snapshot file required');
  if (!['legacy', 'v2'].includes(args.schema)) usage('--schema must be legacy or v2');
  if (!args.league || !/^[a-z0-9-]{3,40}$/.test(args.league)) usage('--league required (e.g. the-league-2627)');

  const src = path.resolve(args.file);
  if (!fs.existsSync(src)) usage(`no snapshot at ${src}`);
  const raw = fs.readFileSync(src, 'utf8').trim();
  if (!raw) { console.error('snapshot is empty — refusing to wipe the league with it'); process.exit(1); }
  let data;
  try { data = JSON.parse(raw); } catch { console.error('snapshot is not valid JSON — refusing'); process.exit(1); }
  if (data === null || (isObj(data) && Object.keys(data).length === 0)) {
    console.error('snapshot is null/empty — refusing to wipe the league with it');
    process.exit(1);
  }
  const schemaErr = checkSchema(args.schema, data);
  if (schemaErr) { console.error(`REFUSING: ${schemaErr}`); process.exit(1); }

  const dbPath = args.schema === 'v2' ? `v2/leagues/${args.league}` : `leagues/${args.league}`;
  const keys = isObj(data) ? Object.keys(data).sort().join(', ') : typeof data;

  console.log(emu ? `target: emulator at ${emu}` : 'target: live RTDB (service account)');
  console.log(`About to OVERWRITE "${dbPath}" with ${src}`);
  console.log(`Snapshot contains: ${keys}`);
  if (!args.yes && (await ask('Type RESTORE to proceed: ')).trim() !== 'RESTORE') {
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

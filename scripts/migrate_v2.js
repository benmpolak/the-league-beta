#!/usr/bin/env node
/* Migrate the legacy league node to the authenticated v2 schema.
 *
 *   legacy:  leagues/<league>                     (one open node)
 *   v2:      v2/leagues/<league>/public           (everything except pins/claims/autolists)
 *            v2/leagues/<league>/private/<uid>    (autolist + claims, per manager)
 *            v2/leagues/<league>/server           (owned by provisioning — NOT written here,
 *                                                  except server/maintenance=false at the end)
 *
 * pins are dropped entirely (Firebase Auth replaces them).
 *
 * Default mode is DRY-RUN: transform + verify + report, no network writes.
 *
 *   Dry-run from a backup file:
 *     node scripts/migrate_v2.js --snapshot data/backups/league.json --uid-map uidmap.local.json
 *
 *   Dry-run reading the live DB (admin SDK only; plain REST is refused):
 *     GOOGLE_APPLICATION_CREDENTIALS=service-account.json \
 *     node scripts/migrate_v2.js --fetch
 *
 *   Write to the emulator (rehearsal):
 *     FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000 \
 *     node scripts/migrate_v2.js --snapshot data/backups/league.json --emulator
 *
 *   Write to the live sandbox league (rehearsal):
 *     GOOGLE_APPLICATION_CREDENTIALS=service-account.json \
 *     node scripts/migrate_v2.js --snapshot data/backups/league.json \
 *       --live --i-have-a-backup --target-league the-league-sandbox
 *
 *   The real thing:
 *     GOOGLE_APPLICATION_CREDENTIALS=service-account.json \
 *     node scripts/migrate_v2.js --snapshot data/backups/league.json --live --i-have-a-backup
 *
 * Writes go ONLY under v2/leagues/<target>; leagues/<league> is never touched.
 * Re-running a write from the same snapshot overwrites v2 deterministically.
 *
 * The uid map (managerId -> Firebase uid) comes from
 * v2/leagues/<target>/server/managerUid (written by scripts/provision_managers.js),
 * or from a local JSON file via --uid-map {"1": "uid...", ...} for offline runs.
 * Migration FAILS if any manager with claims/autolist data is missing from the map.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_URL = 'https://calciopoli-wc26-default-rtdb.europe-west1.firebasedatabase.app';
const PROJECT_ID = 'calciopoli-wc26';
const DEFAULT_LEAGUE = 'the-league-2627';
const REPORT_PATH = path.join(ROOT, 'data', 'migration-report.txt');

const LEGACY_KEYS = ['phase', 'managers', 'settings', 'draft', 'lineups', 'transfers',
  'trades', 'covenants', 'claims', 'waiverMeta', 'autolists', 'pins', 'adjustments',
  'shirtNums', 'draftPool', 'windowDraft', 'tradeBlock', 'benchOrders', 'lobus', 'hamCup'];
const PRIVATE_KEYS = ['claims', 'autolists'];
const DROPPED_KEYS = ['pins'];

/* ---------------- pure transform layer (exported, used by the test) ---------------- */

// Firebase stores arrays as integer-keyed objects and coerces them back
// unpredictably, so every collection is walked through this one lens.
function entriesOf(x) {
  if (x == null) return [];
  if (Array.isArray(x)) return x.map((v, i) => [String(i), v]).filter(([, v]) => v != null);
  if (typeof x === 'object') return Object.entries(x).filter(([, v]) => v != null);
  return [];
}
const countEntries = x => entriesOf(x).length;

// Canonical form = what Firebase would actually store: arrays as index-keyed
// objects, nulls and empty containers pruned, keys sorted. Two values are
// equivalent in RTDB iff their canonical JSON is identical.
function canonical(value) {
  if (value == null) return undefined;
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of entriesOf(value)) {
    const c = canonical(v);
    if (c !== undefined) out[k] = c;
  }
  const keys = Object.keys(out).sort();
  if (!keys.length) return undefined;
  const sorted = {};
  for (const k of keys) sorted[k] = out[k];
  return sorted;
}
const canonicalJson = v => JSON.stringify(canonical(v) ?? null);
const sha256Canonical = v => crypto.createHash('sha256').update(canonicalJson(v)).digest('hex');

function transformToV2(legacy, uidMap) {
  if (legacy == null || typeof legacy !== 'object') throw new Error('legacy snapshot is null or not an object — refusing');
  uidMap = uidMap || {};
  const uidFor = mid => {
    const uid = uidMap[String(mid)];
    if (!uid) throw new Error(`uid map has no entry for managerId ${mid}, which has claims/autolist data — run provisioning first or pass --uid-map`);
    return uid;
  };
  const pub = {};
  for (const [k, v] of Object.entries(legacy)) {
    if (PRIVATE_KEYS.includes(k) || DROPPED_KEYS.includes(k)) continue;
    pub[k] = v;
  }
  const priv = {};
  for (const [mid, list] of entriesOf(legacy.autolists)) {
    const uid = uidFor(mid);
    (priv[uid] = priv[uid] || {}).autolist = list;
  }
  for (const [gw, byMgr] of entriesOf(legacy.claims)) {
    for (const [mid, arr] of entriesOf(byMgr)) {
      const uid = uidFor(mid);
      const node = (priv[uid] = priv[uid] || {});
      (node.claims = node.claims || {})[gw] = arr;
    }
  }
  return { public: pub, private: priv };
}

// v2 -> legacy (pins excepted, they are gone by design)
function inverseTransform(v2, uidMap) {
  const midByUid = {};
  for (const [mid, uid] of Object.entries(uidMap || {})) {
    if (midByUid[uid] !== undefined) throw new Error(`uid map maps managerIds ${midByUid[uid]} and ${mid} to the same uid ${String(uid).slice(0, 8)}`);
    midByUid[uid] = mid;
  }
  const legacy = { ...(v2.public || {}) };
  const autolists = {};
  const claims = {};
  for (const [uid, node] of entriesOf(v2.private)) {
    const mid = midByUid[uid];
    if (mid === undefined) throw new Error(`private data for uid ${uid.slice(0, 8)} which is not in the uid map`);
    if (node.autolist != null) autolists[mid] = node.autolist;
    for (const [gw, arr] of entriesOf(node.claims)) (claims[gw] = claims[gw] || {})[mid] = arr;
  }
  legacy.autolists = autolists;
  legacy.claims = claims;
  return legacy;
}

const claimItemCount = claims => {
  let n = 0;
  for (const [, byMgr] of entriesOf(claims)) for (const [, arr] of entriesOf(byMgr)) n += countEntries(arr);
  return n;
};
const privateClaimItemCount = priv => {
  let n = 0;
  for (const [, node] of entriesOf(priv)) for (const [, arr] of entriesOf(node.claims)) n += countEntries(arr);
  return n;
};

function verifyMigration(legacy, v2, uidMap) {
  const checks = [];
  const add = (label, src, dst) => checks.push({ label, src, dst, ok: canonicalJson(src) === canonicalJson(dst) });

  add('managers', countEntries(legacy.managers), countEntries(v2.public.managers));
  add('draft.picks', countEntries(legacy.draft && legacy.draft.picks), countEntries(v2.public.draft && v2.public.draft.picks));
  add('transfers', countEntries(legacy.transfers), countEntries(v2.public.transfers));
  add('trades', countEntries(legacy.trades), countEntries(v2.public.trades));
  add('covenants', countEntries(legacy.covenants), countEntries(v2.public.covenants));

  const lineupCounts = lineups => {
    const out = {};
    for (const [mid, byGw] of entriesOf(lineups)) out[mid] = countEntries(byGw);
    return out;
  };
  add('lineup gw-entries per manager', lineupCounts(legacy.lineups), lineupCounts(v2.public.lineups));

  add('claims items total', claimItemCount(legacy.claims), privateClaimItemCount(v2.private));

  const srcAuto = {};
  for (const [mid, list] of entriesOf(legacy.autolists)) srcAuto[mid] = countEntries(list);
  const dstAuto = {};
  const midByUid = {};
  for (const [mid, uid] of Object.entries(uidMap || {})) midByUid[uid] = mid;
  for (const [uid, node] of entriesOf(v2.private)) {
    if (node.autolist != null) dstAuto[midByUid[uid]] = countEntries(node.autolist);
  }
  add('autolist length per manager', srcAuto, dstAuto);

  const settingsMissing = [];
  const srcSettings = legacy.settings || {};
  const dstSettings = (v2.public && v2.public.settings) || {};
  for (const k of Object.keys(srcSettings)) {
    if (!(k in dstSettings)) settingsMissing.push(k);
  }
  for (const k of Object.keys(srcSettings.scoring || {})) {
    if (!((dstSettings.scoring || {})[k] !== undefined)) settingsMissing.push(`scoring.${k}`);
  }
  checks.push({
    label: 'settings keys present',
    src: Object.keys(srcSettings).length + Object.keys(srcSettings.scoring || {}).length,
    dst: settingsMissing.length ? `missing: ${settingsMissing.join(', ')}` : 'all',
    ok: settingsMissing.length === 0,
  });

  const srcMinusPins = { ...legacy };
  delete srcMinusPins.pins;
  const rebuilt = inverseTransform(v2, uidMap);
  const srcJson = canonicalJson(srcMinusPins);
  const rtJson = canonicalJson(rebuilt);
  const srcSha = crypto.createHash('sha256').update(srcJson).digest('hex');
  const rtSha = crypto.createHash('sha256').update(rtJson).digest('hex');
  const roundTripOk = srcJson === rtJson;

  return {
    checks,
    srcSha,
    rtSha,
    roundTripOk,
    pass: roundTripOk && srcSha === rtSha && checks.every(c => c.ok),
  };
}

function describeValue(v) {
  if (v === undefined) return 'absent';
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array (${countEntries(v)} entries)`;
  if (typeof v === 'object') return `object (${countEntries(v)} entries)`;
  return `${typeof v}: ${JSON.stringify(v)}`;
}

// Redacted by construction: counts and checksums only. No emails exist in this
// data; PIN hashes never leave the pins count line; uids are truncated.
function buildReport(legacy, v2, uidMap, result, meta) {
  const L = [];
  L.push('THE LEAGUE — v2 migration report');
  L.push(`mode: ${meta.mode}`);
  L.push(`source: ${meta.source}`);
  L.push(`target: v2/leagues/${meta.targetLeague}`);
  L.push('');
  L.push('legacy keys:');
  for (const k of LEGACY_KEYS) {
    if (k === 'pins') L.push(`  pins: dropped (${countEntries(legacy.pins)} entries)`);
    else L.push(`  ${k}: ${describeValue(legacy[k])}`);
  }
  const unexpected = Object.keys(legacy).filter(k => !LEGACY_KEYS.includes(k));
  if (unexpected.length) {
    L.push('');
    L.push(`WARNING unexpected legacy keys (copied to public verbatim): ${unexpected.join(', ')}`);
  }
  L.push('');
  L.push('verification (source vs transformed):');
  for (const c of result.checks) {
    L.push(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.label}: ${JSON.stringify(c.src)} vs ${JSON.stringify(c.dst)}`);
  }
  L.push('');
  L.push('private nodes:');
  for (const [uid, node] of entriesOf(v2.private)) {
    const mids = Object.entries(uidMap || {}).filter(([, u]) => u === uid).map(([m]) => m);
    L.push(`  uid ${uid.slice(0, 8)} (manager ${mids.join(',') || '?'}): autolist ${node.autolist != null ? countEntries(node.autolist) : 0}, claims gws ${countEntries(node.claims)}`);
  }
  if (!countEntries(v2.private)) L.push('  (none)');
  L.push('');
  L.push('round-trip (v2 -> legacy, pins omitted both sides):');
  L.push(`  deep-equal: ${result.roundTripOk ? 'OK' : 'FAIL'}`);
  L.push(`  sha256 source     : ${result.srcSha}`);
  L.push(`  sha256 round-trip : ${result.rtSha}`);
  L.push(`  checksums: ${result.srcSha === result.rtSha ? 'MATCH' : 'MISMATCH'}`);
  L.push('');
  L.push(`RESULT: ${result.pass ? 'PASS' : 'FAIL'}`);
  return L.join('\n') + '\n';
}

module.exports = {
  LEGACY_KEYS, PRIVATE_KEYS, DROPPED_KEYS,
  entriesOf, countEntries, canonical, canonicalJson, sha256Canonical,
  transformToV2, inverseTransform, verifyMigration, buildReport,
};

/* ---------------- CLI ---------------- */

if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}

function parseArgs(argv) {
  const a = { targetLeague: DEFAULT_LEAGUE, sourceLeague: DEFAULT_LEAGUE };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--snapshot') a.snapshot = argv[++i];
    else if (t === '--uid-map') a.uidMapPath = argv[++i];
    else if (t === '--target-league') a.targetLeague = argv[++i];
    else if (t === '--source-league') a.sourceLeague = argv[++i];
    else if (t === '--fetch') a.fetch = true;
    else if (t === '--live') a.live = true;
    else if (t === '--emulator') a.emulator = true;
    else if (t === '--i-have-a-backup') a.backupConfirmed = true;
    else throw new Error(`unknown argument: ${t}`);
  }
  return a;
}

function initAdmin() {
  const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID, databaseURL: DB_URL });
  return admin.database();
}

async function main() {
  const args = parseArgs(process.argv);
  const emu = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  const creds = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (args.live && emu) throw new Error('Refusing: --live given but FIREBASE_DATABASE_EMULATOR_HOST is set. Pick one.');
  if (args.live && args.emulator) throw new Error('Refusing: --live and --emulator together. Pick one.');
  if (args.emulator && !emu) throw new Error('Refusing: --emulator given but FIREBASE_DATABASE_EMULATOR_HOST is not set.');
  if (args.live && !args.backupConfirmed) throw new Error('Refusing: --live requires --i-have-a-backup. Take one first (scripts/backup_league.py), then say so.');
  if (args.live && !creds) throw new Error('Refusing: --live requires GOOGLE_APPLICATION_CREDENTIALS (admin SDK; plain REST is not supported).');
  if (args.snapshot && args.fetch) throw new Error('Refusing: both --snapshot and --fetch given. Pick one source.');
  if (!args.snapshot && !args.fetch) throw new Error('No source: pass --snapshot <file.json> or --fetch.');
  if (args.fetch && !creds && !emu) throw new Error('Refusing: --fetch needs GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_DATABASE_EMULATOR_HOST. Plain REST is not supported.');

  const writeMode = args.live ? 'LIVE' : args.emulator ? 'EMULATOR' : null;
  const needsAdmin = args.fetch || writeMode !== null;
  const db = needsAdmin ? initAdmin() : null;

  let legacy;
  let sourceDesc;
  if (args.snapshot) {
    const p = path.resolve(args.snapshot);
    if (!fs.existsSync(p)) throw new Error(`snapshot not found: ${p}`);
    legacy = JSON.parse(fs.readFileSync(p, 'utf8'));
    sourceDesc = p;
  } else {
    const snap = await db.ref(`leagues/${args.sourceLeague}`).get();
    legacy = snap.val();
    sourceDesc = `${emu ? 'emulator' : 'live'} leagues/${args.sourceLeague}`;
  }
  if (legacy == null) throw new Error('source league is null — nothing to migrate');

  let uidMap = null;
  if (args.uidMapPath) {
    const p = path.resolve(args.uidMapPath);
    if (!fs.existsSync(p)) throw new Error(`uid map not found: ${p}`);
    uidMap = JSON.parse(fs.readFileSync(p, 'utf8'));
  } else if (db) {
    const snap = await db.ref(`v2/leagues/${args.targetLeague}/server/managerUid`).get();
    uidMap = {};
    for (const [mid, uid] of entriesOf(snap.val())) uidMap[mid] = uid;
  }
  uidMap = uidMap || {};

  const v2 = transformToV2(legacy, uidMap);
  const result = verifyMigration(legacy, v2, uidMap);
  const report = buildReport(legacy, v2, uidMap, result, {
    mode: writeMode ? `WRITE (${writeMode})` : 'DRY-RUN',
    source: sourceDesc,
    targetLeague: args.targetLeague,
  });
  process.stdout.write(report);
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, report);
  console.log(`report written to ${REPORT_PATH}`);

  if (!result.pass) {
    console.error('Verification FAILED — nothing was written.');
    process.exit(1);
  }
  if (!writeMode) {
    process.exit(0);
  }

  const base = `v2/leagues/${args.targetLeague}`;
  if (!base.startsWith('v2/leagues/')) throw new Error('write path escaped v2/leagues — refusing');
  await db.ref(`${base}/public`).set(v2.public);
  await db.ref(`${base}/private`).set(Object.keys(v2.private).length ? v2.private : null);
  await db.ref(`${base}/server/maintenance`).set(false);
  console.log(`written: ${base}/public, ${base}/private, ${base}/server/maintenance=false (${writeMode})`);
  console.log('leagues/* was not touched.');
  process.exit(0);
}

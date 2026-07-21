/* Backup + restore safety against the emulator database:
 * backup validates what it fetched (schema + counts) and refuses to record a
 * wipe when it can see the previous run's manifest; restore takes an explicit
 * --schema and --league (nothing inferred from filenames) and refuses null,
 * tiny-wipe, corrupt and wrong-schema snapshots. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const T = require('./testenv.js');

const ROOT = path.join(__dirname, '..');
const BACKUP = path.join(ROOT, 'scripts', 'backup_league.js');
const RESTORE = path.join(ROOT, 'scripts', 'restore_league.js');
const LG = 'the-league-2627';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tl-bak-'));
function runScript(script, args, extraEnv = {}) {
  const env = { ...process.env, FIREBASE_DATABASE_EMULATOR_HOST: T.DB_HOST, ...extraEnv };
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  const res = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
  return { code: res.status, out: res.stdout + res.stderr };
}
const runBackup = (outDir, prevDir, extra = {}) =>
  runScript(BACKUP, [], { LEAGUE_BACKUP_DIR: outDir, ...(prevDir ? { PREV_BACKUP_DIR: prevDir } : {}), ...extra });
const runRestore = args => runScript(RESTORE, args);

(async () => {
  const run = T.makeRunner('backup');
  const { chk } = run;
  const { players } = T.genTestData();
  await T.wipe();
  const db = T.initAdmin().database();

  /* seed both schemas with a substantial league */
  const seed = T.buildSeedState(players, 3);
  await db.ref(`leagues/${LG}`).set(seed);
  await db.ref(`v2/leagues/${LG}`).set({
    public: seed,
    private: { u1: { autolist: [101, 102] } },
    server: { membership: { u1: { managerId: 1, role: 'commissioner' } } },
  });

  /* valid backup: files + manifest with real counts */
  const dir1 = tmp();
  const b1 = runBackup(dir1, null);
  chk('valid backup exits clean', b1.code === 0, b1.out.slice(0, 300));
  chk('both snapshots written', fs.existsSync(path.join(dir1, 'league.json')) && fs.existsSync(path.join(dir1, 'league-v2.json')));
  const man1 = JSON.parse(fs.readFileSync(path.join(dir1, 'manifest.json'), 'utf8'));
  chk('manifest records counts', man1.targets.legacy.present && man1.targets.legacy.topCounts.managers === 3
    && man1.targets.v2.topCounts.public > 0, JSON.stringify(man1.targets));

  /* wipe scenario: DB nulled, previous manifest present -> backup FAILS */
  await db.ref(`leagues/${LG}`).set(null);
  await db.ref(`v2/leagues/${LG}`).set(null);
  const dir2 = tmp();
  const b2 = runBackup(dir2, dir1);
  chk('nulled database vs previous manifest fails the run', b2.code === 1, b2.out.slice(0, 300));
  chk('no snapshot recorded for the wiped target', !fs.existsSync(path.join(dir2, 'league.json')));

  /* tiny scenario: league shrank to a stub -> fails; ALLOW_SHRINK overrides */
  await db.ref(`leagues/${LG}`).set({ phase: 'setup', managers: [{ id: 1, name: 'A', team: 'B' }, { id: 2, name: 'C', team: 'D' }] });
  const dir3 = tmp();
  const b3 = runBackup(dir3, dir1);
  chk('tiny snapshot vs substantial previous fails the run', b3.code === 1, b3.out.slice(0, 300));
  const b3b = runBackup(dir3, dir1, { ALLOW_SHRINK: '1' });
  chk('intentional reset recordable with ALLOW_SHRINK=1', b3b.code === 0, b3b.out.slice(0, 300));

  /* malformed schema in the database itself -> fails validation */
  await db.ref(`leagues/${LG}`).set({ blob: 'not a league' });
  const b4 = runBackup(tmp(), null);
  chk('schema-invalid snapshot fails validation', b4.code === 1, b4.out.slice(0, 300));

  /* ---- restore ---- */
  const legacySnap = path.join(dir1, 'league.json');
  const v2Snap = path.join(dir1, 'league-v2.json');

  chk('restore without --schema refused', runRestore([legacySnap, '--league', LG, '--yes']).code === 1);
  chk('restore without --league refused', runRestore([legacySnap, '--schema', 'legacy', '--yes']).code === 1);
  chk('restore with junk schema refused', runRestore([legacySnap, '--schema', 'vintage', '--league', LG, '--yes']).code === 1);

  const nullFile = path.join(tmp(), 'null.json');
  fs.writeFileSync(nullFile, 'null');
  chk('null snapshot refused', runRestore([nullFile, '--schema', 'legacy', '--league', LG, '--yes']).code === 1);
  const emptyFile = path.join(tmp(), 'empty.json');
  fs.writeFileSync(emptyFile, '{}');
  chk('empty snapshot refused', runRestore([emptyFile, '--schema', 'legacy', '--league', LG, '--yes']).code === 1);
  const corruptFile = path.join(tmp(), 'corrupt.json');
  fs.writeFileSync(corruptFile, '{"public": {"phase"');
  chk('corrupt snapshot refused', runRestore([corruptFile, '--schema', 'v2', '--league', LG, '--yes']).code === 1);

  const wrong1 = runRestore([legacySnap, '--schema', 'v2', '--league', LG, '--yes']);
  chk('legacy snapshot declared as v2 refused', wrong1.code === 1 && /LEGACY snapshot/.test(wrong1.out), wrong1.out.slice(0, 200));
  const wrong2 = runRestore([v2Snap, '--schema', 'legacy', '--league', LG, '--yes']);
  chk('v2 snapshot declared as legacy refused', wrong2.code === 1 && /V2 snapshot/.test(wrong2.out), wrong2.out.slice(0, 200));

  /* valid restores land in exactly the declared tree */
  await db.ref(`leagues/${LG}`).set(null);
  await db.ref(`v2/leagues/${LG}`).set(null);
  const r1 = runRestore([legacySnap, '--schema', 'legacy', '--league', LG, '--yes']);
  chk('valid legacy restore succeeds', r1.code === 0, r1.out.slice(0, 300));
  const backLegacy = (await db.ref(`leagues/${LG}`).get()).val();
  chk('legacy tree restored faithfully', backLegacy?.phase === 'season' && Object.keys(backLegacy?.managers || {}).length === 3);
  chk('v2 tree untouched by a legacy restore', !(await db.ref(`v2/leagues/${LG}`).get()).val());
  const r2 = runRestore([v2Snap, '--schema', 'v2', '--league', LG, '--yes']);
  chk('valid v2 restore succeeds', r2.code === 0, r2.out.slice(0, 300));
  const backV2 = (await db.ref(`v2/leagues/${LG}`).get()).val();
  chk('v2 tree restored with private + server intact',
    backV2?.public?.phase === 'season' && !!backV2?.private?.u1 && !!backV2?.server?.membership?.u1);

  run.done();
})().catch(e => { console.error(e); process.exit(1); });

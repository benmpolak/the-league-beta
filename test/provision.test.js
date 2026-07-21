/* Provisioning lifecycle against the emulators: adding managers works, and —
 * the part that used to leak authority — PRUNING a manager removes their
 * membership, rebuilds the managerId->uid map with no stale entries, and
 * clears their league custom claims. Reassignment leaves no orphan mappings. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const T = require('./testenv.js');

const LG = 'the-league-2627';
const SCRIPT = path.join(__dirname, '..', 'scripts', 'provision_managers.js');

function runProvision(cfg) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-prov-')), 'managers.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  const res = spawnSync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      MANAGERS_FILE: file,
      FIREBASE_AUTH_EMULATOR_HOST: T.AUTH_HOST,
      FIREBASE_DATABASE_EMULATOR_HOST: T.DB_HOST,
    },
    encoding: 'utf8',
  });
  return { code: res.status, out: res.stdout + res.stderr };
}

(async () => {
  const run = T.makeRunner('provision');
  const { chk } = run;
  await T.wipe();
  const db = T.initAdmin().database();
  const auth = T.initAdmin().auth();

  /* round 1: three managers */
  const r1 = runProvision({
    leagues: [LG],
    managers: [
      { managerId: 1, email: 'p-chair@test.local', role: 'commissioner' },
      { managerId: 2, email: 'p-two@test.local' },
      { managerId: 3, email: 'p-three@test.local' },
    ],
  });
  chk('provision run 1 exits clean', r1.code === 0, r1.out.slice(0, 300));
  const mem1 = (await db.ref(`v2/leagues/${LG}/server/membership`).get()).val() || {};
  const map1 = (await db.ref(`v2/leagues/${LG}/server/managerUid`).get()).val() || {};
  chk('three memberships written', Object.keys(mem1).length === 3);
  chk('managerUid maps all three', [1, 2, 3].every(mid => !!map1[mid]));
  const uid3 = map1[3];
  const u3 = await auth.getUser(uid3);
  chk('claims hint written', u3.customClaims?.leagues?.[LG]?.managerId === 3);

  /* round 2: manager 3 is out; manager 2 is REASSIGNED to id 3 */
  const r2 = runProvision({
    leagues: [LG],
    managers: [
      { managerId: 1, email: 'p-chair@test.local', role: 'commissioner' },
      { managerId: 3, email: 'p-two@test.local' },
    ],
  });
  chk('provision run 2 exits clean', r2.code === 0, r2.out.slice(0, 300));
  const mem2 = (await db.ref(`v2/leagues/${LG}/server/membership`).get()).val() || {};
  const map2 = (await db.ref(`v2/leagues/${LG}/server/managerUid`).get()).val() || {};
  chk('pruned user lost membership', !mem2[uid3]);
  chk('two memberships remain', Object.keys(mem2).length === 2);
  chk('managerUid rebuilt with NO stale mapping', !map2[2] && Object.keys(map2).length === 2, JSON.stringify(map2));
  chk('reassigned manager points at the surviving uid', map2[3] === map1[2]);
  const u3after = await auth.getUser(uid3);
  chk('pruned user\'s league claims cleared', !u3after.customClaims?.leagues?.[LG], JSON.stringify(u3after.customClaims));
  const u2after = await auth.getUser(map1[2]);
  chk('reassigned manager\'s claims track the new id', u2after.customClaims?.leagues?.[LG]?.managerId === 3);

  /* idempotence: same file twice is a no-op */
  const r3 = runProvision({
    leagues: [LG],
    managers: [
      { managerId: 1, email: 'p-chair@test.local', role: 'commissioner' },
      { managerId: 3, email: 'p-two@test.local' },
    ],
  });
  chk('re-run is idempotent', r3.code === 0
    && JSON.stringify(await (await db.ref(`v2/leagues/${LG}/server/managerUid`).get()).val()) === JSON.stringify(map2));

  run.done();
})().catch(e => { console.error(e); process.exit(1); });

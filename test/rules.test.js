/* Database rules v2, proven against the emulator:
 * deny by default; public subtree world-readable; private per-owner; server
 * membership self-only; and NO client write lands anywhere. */
'use strict';
const T = require('./testenv.js');

(async () => {
  const run = T.makeRunner('rules');
  const { chk } = run;
  const LG = 'the-league-2627';
  await T.wipe();

  const members = await T.provision(LG, [
    { managerId: 1, email: 'a@test.local', role: 'commissioner' },
    { managerId: 2, email: 'b@test.local' },
  ]);
  const tokA = await T.idTokenFor(members[1].uid);
  const tokB = await T.idTokenFor(members[2].uid);

  // seed some state with admin (bypasses rules, as the functions do)
  const db = T.initAdmin().database();
  await db.ref(`v2/leagues/${LG}/public`).set({ phase: 'season', managers: [{ id: 1, name: 'A', team: 'TA' }] });
  await db.ref(`v2/leagues/${LG}/private/${members[1].uid}/autolist`).set([101, 102]);
  await db.ref(`v2/leagues/${LG}/private/${members[2].uid}/claims/2`).set([{ in: 103, out: 104 }]);
  await db.ref(`v2/leagues/${LG}/server/waiverRuns/r1`).set({ status: 'done' });
  await db.ref('leagues/legacy-test').set({ phase: 'season', managers: [{ id: 1 }] });

  /* ---- anonymous ---- */
  chk('anon reads public', (await T.rest('GET', `v2/leagues/${LG}/public`)).status === 200);
  chk('anon reads legacy (frozen read-only)', (await T.rest('GET', 'leagues/legacy-test')).status === 200);
  chk('anon read of private denied', (await T.rest('GET', `v2/leagues/${LG}/private/${members[1].uid}`)).status === 403 || (await T.rest('GET', `v2/leagues/${LG}/private/${members[1].uid}`)).status === 401);
  chk('anon read of whole league denied', [401, 403].includes((await T.rest('GET', `v2/leagues/${LG}`)).status));
  chk('anon read of membership denied', [401, 403].includes((await T.rest('GET', `v2/leagues/${LG}/server/membership`)).status));
  chk('anon write to public denied', [401, 403].includes((await T.rest('PUT', `v2/leagues/${LG}/public/phase`, { body: 'setup' })).status));
  chk('anon write to legacy denied', [401, 403].includes((await T.rest('PUT', 'leagues/legacy-test/phase', { body: 'setup' })).status));
  chk('anon write to random root denied', [401, 403].includes((await T.rest('PUT', 'junk', { body: { x: 1 } })).status));

  /* ---- manager A (authenticated) ---- */
  chk('A reads public', (await T.rest('GET', `v2/leagues/${LG}/public`, { token: tokA })).status === 200);
  chk('A reads own private', (await T.rest('GET', `v2/leagues/${LG}/private/${members[1].uid}`, { token: tokA })).status === 200);
  chk('A cannot read B private (blind claims stay blind)', [401, 403].includes((await T.rest('GET', `v2/leagues/${LG}/private/${members[2].uid}`, { token: tokA })).status));
  chk('A reads own membership', (await T.rest('GET', `v2/leagues/${LG}/server/membership/${members[1].uid}`, { token: tokA })).status === 200);
  chk('A cannot read B membership', [401, 403].includes((await T.rest('GET', `v2/leagues/${LG}/server/membership/${members[2].uid}`, { token: tokA })).status));
  chk('A reads waiverRuns (transparency)', (await T.rest('GET', `v2/leagues/${LG}/server/waiverRuns`, { token: tokA })).status === 200);

  /* ---- no client writes, even as the commissioner's own uid ---- */
  chk('A (commissioner) cannot write public', [401, 403].includes((await T.rest('PUT', `v2/leagues/${LG}/public/phase`, { token: tokA, body: 'setup' })).status));
  chk('A cannot write own private directly', [401, 403].includes((await T.rest('PUT', `v2/leagues/${LG}/private/${members[1].uid}/autolist`, { token: tokA, body: [1] })).status));
  chk('A cannot write B private', [401, 403].includes((await T.rest('PUT', `v2/leagues/${LG}/private/${members[2].uid}/autolist`, { token: tokA, body: [1] })).status));
  chk('A cannot write membership (role self-promotion)', [401, 403].includes((await T.rest('PUT', `v2/leagues/${LG}/server/membership/${members[1].uid}/role`, { token: tokA, body: 'commissioner' })).status));
  chk('B cannot write waiverRuns', [401, 403].includes((await T.rest('PUT', `v2/leagues/${LG}/server/waiverRuns/r2`, { token: tokB, body: { status: 'done' } })).status));
  chk('B cannot delete the league', [401, 403].includes((await T.rest('DELETE', `v2/leagues/${LG}`, { token: tokB })).status));

  /* ---- admin path still works (functions/backups) ---- */
  chk('admin (owner) write works', (await T.rest('PUT', `v2/leagues/${LG}/server/waiverRuns/r2`, { owner: true, body: { status: 'done' } })).status === 200);

  run.done();
})().catch(e => { console.error(e); process.exit(1); });

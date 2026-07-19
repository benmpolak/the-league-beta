#!/usr/bin/env node
/* Provision the 12 managers as Firebase Auth users and write server-owned membership.
 *
 * Reads managers.local.json (gitignored — NEVER commit it):
 *   {
 *     "leagues": ["the-league-2627", "the-league-sandbox"],
 *     "managers": [
 *       { "managerId": 0, "email": "ben@example.com", "role": "commissioner" },
 *       { "managerId": 1, "email": "toby@example.com" }
 *     ]
 *   }
 *
 * Idempotent: safe to re-run; existing users are found by email, claims and
 * membership are overwritten to match the file.
 *
 * Against the emulator:  FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
 *                        FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000 \
 *                        node scripts/provision_managers.js
 * Against live:          GOOGLE_APPLICATION_CREDENTIALS=service-account.json \
 *                        node scripts/provision_managers.js --live
 */
'use strict';
const fs = require('fs');
const path = require('path');
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));

const LIVE = process.argv.includes('--live');
const emu = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (!LIVE && !emu) {
  console.error('Refusing: no emulator env set and --live not given.');
  process.exit(1);
}
if (LIVE && emu) {
  console.error('Refusing: --live given but emulator env vars are set. Pick one.');
  process.exit(1);
}

const cfgPath = path.join(__dirname, '..', 'managers.local.json');
if (!fs.existsSync(cfgPath)) {
  console.error('managers.local.json not found (see header of this script for the shape).');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

admin.initializeApp({
  projectId: 'calciopoli-wc26',
  databaseURL: 'https://calciopoli-wc26-default-rtdb.europe-west1.firebasedatabase.app',
});
const db = admin.database();

(async () => {
  const report = [];
  for (const m of cfg.managers) {
    if (!Number.isInteger(m.managerId) || !m.email) throw new Error(`bad entry: ${JSON.stringify({ ...m, email: '<redacted>' })}`);
    const role = m.role === 'commissioner' ? 'commissioner' : 'manager';
    let user;
    try {
      user = await admin.auth().getUserByEmail(m.email);
    } catch {
      user = await admin.auth().createUser({ email: m.email, emailVerified: false });
    }
    const leagues = {};
    for (const lg of cfg.leagues) leagues[lg] = { managerId: m.managerId, role };
    await admin.auth().setCustomUserClaims(user.uid, { leagues });
    for (const lg of cfg.leagues) {
      await db.ref(`v2/leagues/${lg}/server/membership/${user.uid}`).set({ managerId: m.managerId, role });
      await db.ref(`v2/leagues/${lg}/server/managerUid/${m.managerId}`).set(user.uid);
    }
    report.push({ managerId: m.managerId, uid: user.uid, role });
  }
  // prune membership entries for users no longer in the file
  for (const lg of cfg.leagues) {
    const snap = await db.ref(`v2/leagues/${lg}/server/membership`).get();
    const keep = new Set(report.map(r => r.uid));
    const val = snap.val() || {};
    for (const uid of Object.keys(val)) {
      if (!keep.has(uid)) {
        await db.ref(`v2/leagues/${lg}/server/membership/${uid}`).remove();
        report.push({ pruned: uid, league: lg });
      }
    }
  }
  console.log(JSON.stringify({ target: LIVE ? 'LIVE' : 'emulator', provisioned: report }, null, 2));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });

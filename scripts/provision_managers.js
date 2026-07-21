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

// MANAGERS_FILE override exists for the emulator test suite only
const cfgPath = process.env.MANAGERS_FILE || path.join(__dirname, '..', 'managers.local.json');
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
    // claims are a client-side hint only (the server always checks membership),
    // kept in sync here so the UI reflects reality after a token refresh
    await admin.auth().setCustomUserClaims(user.uid, { leagues });
    for (const lg of cfg.leagues) {
      await db.ref(`v2/leagues/${lg}/server/membership/${user.uid}`).set({ managerId: m.managerId, role });
    }
    report.push({ managerId: m.managerId, uid: user.uid, role });
  }
  const keep = new Set(report.filter(r => r.uid).map(r => r.uid));
  const prunedUids = new Set();
  for (const lg of cfg.leagues) {
    // managerUid is rebuilt wholesale from the file, so a reassigned or removed
    // manager can never leave a stale managerId -> uid mapping behind
    const uidMap = {};
    for (const r of report) if (r.uid && Number.isInteger(r.managerId)) uidMap[r.managerId] = r.uid;
    await db.ref(`v2/leagues/${lg}/server/managerUid`).set(uidMap);
    // prune membership entries for users no longer in the file
    const snap = await db.ref(`v2/leagues/${lg}/server/membership`).get();
    const val = snap.val() || {};
    for (const uid of Object.keys(val)) {
      if (!keep.has(uid)) {
        await db.ref(`v2/leagues/${lg}/server/membership/${uid}`).remove();
        prunedUids.add(uid);
        report.push({ pruned: uid, league: lg });
      }
    }
  }
  // a pruned user's custom claims are cleared for these leagues too — the
  // claim is only a hint, but a stale hint helps nobody
  for (const uid of prunedUids) {
    try {
      const u = await admin.auth().getUser(uid);
      const claims = { ...(u.customClaims || {}) };
      const lgs = { ...(claims.leagues || {}) };
      for (const lg of cfg.leagues) delete lgs[lg];
      claims.leagues = Object.keys(lgs).length ? lgs : null;
      await admin.auth().setCustomUserClaims(uid, claims);
      report.push({ claimsCleared: uid });
    } catch { /* auth user already deleted — nothing to clear */ }
  }
  console.log(JSON.stringify({ target: LIVE ? 'LIVE' : 'emulator', provisioned: report }, null, 2));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });

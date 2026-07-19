// v2 migration transform test — pure, no network, no emulator.
// Usage: node test/migrate.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const {
  transformToV2, inverseTransform, verifyMigration, buildReport,
  canonicalJson, sha256Canonical, entriesOf,
} = require('../scripts/migrate_v2.js');

const fixturePath = path.join(__dirname, 'fixtures', 'legacy-league.json');
const legacy = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

const uidMap = {
  '1': 'testuid-manager-one-aaaa0001',
  '2': 'testuid-manager-two-bbbb0002',
  '3': 'testuid-manager-thr-cccc0003',
};

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const v2 = transformToV2(legacy, uidMap);

// ---------- shape: public ----------
check('public has no pins', !('pins' in v2.public));
check('public has no claims', !('claims' in v2.public));
check('public has no autolists', !('autolists' in v2.public));
const expectedPublicKeys = Object.keys(legacy).filter(k => !['pins', 'claims', 'autolists'].includes(k)).sort();
check('public keys = legacy minus pins/claims/autolists',
  JSON.stringify(Object.keys(v2.public).sort()) === JSON.stringify(expectedPublicKeys));
check('public copies verbatim (draft)', canonicalJson(v2.public.draft) === canonicalJson(legacy.draft));
check('public copies verbatim (settings incl. scoring)', canonicalJson(v2.public.settings) === canonicalJson(legacy.settings));
check('hamCup null survives as null', v2.public.hamCup === null);

// ---------- shape: private ----------
check('private/<uid1>/autolist', JSON.stringify(v2.private[uidMap['1']].autolist) === JSON.stringify([420, 421, 422]));
check('private/<uid2>/autolist', JSON.stringify(v2.private[uidMap['2']].autolist) === JSON.stringify([430]));
check('private/<uid2>/claims/2 (two ranked claims)',
  JSON.stringify(v2.private[uidMap['2']].claims['2']) === JSON.stringify(legacy.claims['2']['2']));
check('private/<uid1>/claims/2 (single claim)',
  JSON.stringify(v2.private[uidMap['1']].claims['2']) === JSON.stringify(legacy.claims['2']['1']));
check('private/<uid3>/claims/3', JSON.stringify(v2.private[uidMap['3']].claims['3']) === JSON.stringify(legacy.claims['3']['3']));
check('no pin hash anywhere in v2', !canonicalJson(v2).includes(legacy.pins['1']));

// ---------- verification ----------
const result = verifyMigration(legacy, v2, uidMap);
for (const c of result.checks) check(`verify: ${c.label}`, c.ok, `${JSON.stringify(c.src)} vs ${JSON.stringify(c.dst)}`);
check('verify: round-trip deep-equal', result.roundTripOk);
check('verify: checksums match', result.srcSha === result.rtSha, result.srcSha.slice(0, 12));
check('verify: overall PASS', result.pass);

// expected concrete counts from the fixture
const claimsCheck = result.checks.find(c => c.label === 'claims items total');
check('fixture has 4 claim items', claimsCheck.src === 4, String(claimsCheck.src));

// ---------- explicit inverse ----------
const rebuilt = inverseTransform(v2, uidMap);
const srcMinusPins = { ...legacy };
delete srcMinusPins.pins;
check('inverse(transform(x)) canonical-equal x minus pins', canonicalJson(rebuilt) === canonicalJson(srcMinusPins));
check('sha256 of rebuilt equals sha256 of source minus pins', sha256Canonical(rebuilt) === sha256Canonical(srcMinusPins));

// ---------- determinism ----------
check('transform is deterministic', sha256Canonical(transformToV2(legacy, uidMap)) === sha256Canonical(v2));

// ---------- Firebase array coercion: dense integer keys come back as arrays ----------
const arrayForm = JSON.parse(JSON.stringify(legacy));
arrayForm.claims = [null, null, legacy.claims['2'], legacy.claims['3']];
arrayForm.autolists = [null, legacy.autolists['1'], legacy.autolists['2'], legacy.autolists['3']];
const v2FromArrays = transformToV2(arrayForm, uidMap);
check('array-coerced claims/autolists give identical v2', sha256Canonical(v2FromArrays) === sha256Canonical(v2));
const resultArrays = verifyMigration(arrayForm, v2FromArrays, uidMap);
check('array-coerced source still verifies PASS', resultArrays.pass);

// ---------- missing uid must fail loudly ----------
let threw = false;
try {
  transformToV2(legacy, { '1': uidMap['1'], '2': uidMap['2'] }); // manager 3 has claims + autolist
} catch (e) {
  threw = /managerId 3/.test(e.message);
}
check('missing uid for manager with private data throws', threw);

let threwEmpty = false;
try {
  transformToV2(legacy, {});
} catch (e) {
  threwEmpty = true;
}
check('empty uid map with private data throws', threwEmpty);

// no private data -> uid map not needed
const bare = { ...legacy };
delete bare.claims;
delete bare.autolists;
const v2Bare = transformToV2(bare, {});
check('no claims/autolists needs no uid map', Object.keys(v2Bare.private).length === 0);

// ---------- report redaction ----------
const report = buildReport(legacy, v2, uidMap, result, { mode: 'DRY-RUN', source: 'fixture', targetLeague: 'the-league-2627' });
check('report says pins dropped with count', report.includes('pins: dropped (3 entries)'));
check('report never contains a PIN hash', !report.includes(legacy.pins['1']) && !report.includes(legacy.pins['2']) && !report.includes(legacy.pins['3']));
check('report never contains a full uid', !report.includes(uidMap['1']));
check('report shows 8-char uid prefix', report.includes(uidMap['1'].slice(0, 8)));
check('report ends PASS', report.includes('RESULT: PASS'));

// ---------- entriesOf sanity ----------
check('entriesOf skips array nulls', JSON.stringify(entriesOf([null, 'a'])) === JSON.stringify([['1', 'a']]));
check('entriesOf skips object nulls', JSON.stringify(entriesOf({ a: null, b: 1 })) === JSON.stringify([['b', 1]]));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);

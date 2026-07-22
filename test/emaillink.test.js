/* requestSignInLink (EMAIL-FALLBACK-DESIGN.md), proven against the emulators
 * with a controllable local mail-provider stub:
 *   membership gate, enumeration resistance (byte-identical generic responses),
 *   per-email and per-IP throttling, provider failure with retries,
 *   duplicate (idempotency-key) suppression, and completion of a delivered
 *   link through the standard email-link flow. */
'use strict';
const http = require('http');
const T = require('./testenv.js');

const LG = 'the-league-2627';
const MAIL_PORT = 8127;

/* ---- controllable mail-provider stub ---- */
function startMailStub() {
  const state = { sent: [], attempts: 0, failMode: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (req.url === '/__reset') { state.sent = []; state.attempts = 0; state.failMode = false; res.end('ok'); return; }
      if (req.url === '/__fail') { state.failMode = body === 'on'; res.end('ok'); return; }
      if (req.url === '/__state') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(state)); return; }
      state.attempts++;
      if (state.failMode) { res.statusCode = 503; res.end('{"error":"stub down"}'); return; }
      state.sent.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      res.end('{"messageId":"stub-' + state.sent.length + '"}');
    });
  });
  return new Promise(resolve => server.listen(MAIL_PORT, '127.0.0.1', () => resolve({ server, state })));
}
const stubCtl = (path, body = '') => fetch(`http://127.0.0.1:${MAIL_PORT}${path}`, { method: 'POST', body }).then(r => r.text());
const stubState = () => fetch(`http://127.0.0.1:${MAIL_PORT}/__state`).then(r => r.json());

(async () => {
  const run = T.makeRunner('emaillink');
  const { chk } = run;
  T.genTestData();
  const server = await T.serveTestData(require('path').join(__dirname, 'fixtures', 'testdata'));
  const { server: mail } = await startMailStub();
  await T.wipe();
  const db = T.initAdmin().database();
  const clearGuard = () => db.ref('v2/mailGuard').set(null);

  await T.provision(LG, [
    { managerId: 1, email: 'chair@test.local', role: 'commissioner' },
    { managerId: 2, email: 'two@test.local' },
    { managerId: 3, email: 'three@test.local' },
    { managerId: 4, email: 'four@test.local' },
  ]);
  // a Firebase user who exists but has NO membership (revoked)
  await T.initAdmin().auth().createUser({ email: 'revoked@test.local' });

  const ask = (email, extra = {}) => T.call('requestSignInLink', { league: LG, email, ...extra }, null);

  /* ---- member: link generated and delivered ---- */
  const r1 = await ask('chair@test.local', { idempotencyKey: 'idem-chair-1' });
  chk('member request returns generic success', r1.result?.ok === true, JSON.stringify(r1));
  let st = await stubState();
  chk('exactly one email delivered', st.sent.length === 1);
  chk('delivered to the right address', st.sent[0]?.to?.[0]?.email === 'chair@test.local');
  const link = (st.sent[0]?.textContent.match(/https?:\S+/) || [])[0];
  chk('email carries a sign-in link', !!link && link.includes('oobCode='), (link || '').slice(0, 60));
  chk('link is the standard email-link format (mode=signIn)', !!link && link.includes('mode=signIn'));
  chk('response never contains the link', !JSON.stringify(r1).includes('oobCode'));

  /* ---- the delivered link completes the EXISTING flow ---- */
  const oob = decodeURIComponent((link.match(/oobCode=([^&]+)/) || [])[1] || '');
  const done = await fetch(`http://${T.AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithEmailLink?key=fake`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'chair@test.local', oobCode: oob }),
  }).then(r => r.json());
  chk('delivered link completes sign-in (existing flow untouched)', !!done.idToken, JSON.stringify(done.error || {}));

  /* ---- enumeration resistance: byte-identical outcomes ---- */
  await clearGuard();
  const member = await ask('two@test.local');
  const unknown = await ask('nobody@test.local');
  const revoked = await ask('revoked@test.local');
  const badShape = await ask('not-an-email');
  const badLeague = await T.call('requestSignInLink', { league: 'nope', email: 'two@test.local' }, null);
  const bodies = [member, unknown, revoked, badShape, badLeague].map(r => JSON.stringify(r.result));
  chk('member/unknown/revoked/malformed/bad-league responses are identical', new Set(bodies).size === 1, bodies.join(' | '));
  st = await stubState();
  chk('only the member response produced an email', st.sent.length === 2 && st.sent[1].to[0].email === 'two@test.local');

  /* ---- throttling by email hash: 3 per 15 min ---- */
  await clearGuard(); await stubCtl('/__reset');
  const throttled = [];
  for (let i = 0; i < 4; i++) throttled.push((await ask('three@test.local')).result);
  st = await stubState();
  chk('4 requests, exactly 3 emails (4th throttled)', st.sent.length === 3, `sent ${st.sent.length}`);
  chk('throttled response is still the generic success', JSON.stringify(throttled[3]) === JSON.stringify(throttled[0]));
  const eBuckets = (await db.ref('v2/mailGuard/email').get()).val() || {};
  chk('email bucket recorded 3 grants (4th aborted)', Object.values(eBuckets).some(a => Object.keys(a || {}).length === 3));

  /* ---- throttling by IP hash: 10 per 15 min ---- */
  await clearGuard(); await stubCtl('/__reset');
  for (let i = 0; i < 11; i++) await ask(`stranger${i}@test.local`);
  const ipBuckets = (await db.ref('v2/mailGuard/ip').get()).val() || {};
  chk('IP bucket capped at 10 grants (11th aborted)', Object.values(ipBuckets).some(a => Object.keys(a || {}).length === 10),
    JSON.stringify(Object.values(ipBuckets).map(a => Object.keys(a || {}).length)));
  chk('no emails for unknown addresses regardless', (await stubState()).sent.length === 0);

  /* ---- duplicate request: same idempotency key = one email ---- */
  await clearGuard(); await stubCtl('/__reset');
  const d1 = await ask('four@test.local', { idempotencyKey: 'same-key' });
  const d2 = await ask('four@test.local', { idempotencyKey: 'same-key' });
  st = await stubState();
  chk('same idempotency key twice delivers ONE email', st.sent.length === 1, `sent ${st.sent.length}`);
  chk('duplicate response is the generic success', JSON.stringify(d2.result) === JSON.stringify(d1.result));

  /* ---- provider failure: retries, then still generic ---- */
  await clearGuard(); await stubCtl('/__reset'); await stubCtl('/__fail', 'on');
  const pf = await ask('chair@test.local', { idempotencyKey: 'idem-fail-1' });
  st = await stubState();
  chk('provider down: 3 attempts made (retries)', st.attempts === 3, `attempts ${st.attempts}`);
  chk('provider down: caller still sees generic success', pf.result?.ok === true && JSON.stringify(pf.result) === JSON.stringify(r1.result));
  await stubCtl('/__fail', 'off');

  server.close(); mail.close();
  run.done();
})().catch(e => { console.error(e); process.exit(1); });

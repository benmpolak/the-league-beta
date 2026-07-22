# Sign-in Link Delivery Fallback — Design (NOT IMPLEMENTED)

Status: **BUILT 22 Jul 2026** ("build it" — Ben). Implemented as
`requestSignInLink` in functions/index.js, tested by test/emaillink.test.js
(18 checks: membership gate, enumeration resistance, email+IP throttling,
idempotency, provider failure/retries, delivered-link completion).
Provider: **Brevo** free tier with single verified sender (no domain purchased
— not authorised; the Resend+domain upgrade below remains the documented path
if deliverability disappoints). Go-live needs Ben: Brevo signup + sender
verification + API key into Secret Manager, then a functions deploy.

## Problem

Firebase's default mail relay accepts `EMAIL_SIGNIN` oob requests for this
project (HTTP 200) but delivers nothing (six sends, 12+ hours, Gmail recipient,
not in spam). Generation and completion are proven healthy: an Admin-generated
link — byte-identical to what the email would carry — completed sign-in on the
live beta site. Only the delivery leg is broken. Support ticket filed; this is
the supported fallback if the relay stays dead.

## Shape

One new **unauthenticated** callable, `requestSignInLink`. The caller has no
identity — before sign-in there is nothing to trust — so the function trusts
NOTHING in the request beyond the email string it is about to look up, and its
design goal is to be useless to anyone but the twelve managers:

```
client sendLink(email)
  └─ httpsCallable('requestSignInLink', { email, idempotencyKey })
       1. normalise email: trim, lowercase, NFC; reject > 254 chars or
          syntactically invalid (generic response, see 4)
       2. rate-limit BEFORE any lookup (see below); over-limit → generic
          success response, nothing sent
       3. admin.auth().getUserByEmail(normalised) → uid, or not-found
       4. uid must hold CURRENT server membership:
          v2/leagues/$league/server/membership/$uid exists — membership is
          the only authority, exactly as in actor(); custom claims ignored
       5. known + member → generateSignInWithEmailLink(email, actionCodeSettings)
          → deliver via Resend API. The LINK IS NEVER RETURNED to the caller
          and never logged.
       6. EVERY path — unknown email, known-but-not-member, rate-limited,
          Resend failure after retries — returns the SAME response shape on
          the SAME timing envelope (single code path with a constant-delay
          floor): { ok: true, message: 'If that address belongs to a manager,
          a sign-in link is on its way.' }
          The response never reveals whether an address is registered.
```

Client change is one line (sendLink body); the **completion flow is untouched**
— the emailed link is the standard Firebase action URL, handled by the existing
`completeLink()` path proven live on 22 Jul.

## Abuse controls

- **Rate limiting**, enforced server-side in RTDB under `server/rateLimits/`
  (admin-only subtree, invisible to clients):
  - by `sha256(normalised email)` — max 3 requests / 15 min, 10 / day
  - by `sha256(source IP)` (from the callable's rawRequest) — max 10 / 15 min
  - buckets are hashed so the limit store never contains addresses or IPs
- **App Check**: `enforceAppCheck: true` the moment App Check is enabled on
  the project (cutover step 5 in README); until then the limiter carries it.
- **Idempotency key**: client sends a UUID per user action; the function
  records `sha256(idemKey)` with a 10-minute TTL and silently swallows
  replays — a double-tap or client retry causes ONE email, not two.

## Secrets & config

- Resend API key in **Cloud Functions Secret Manager**
  (`defineSecret('RESEND_API_KEY')`) — never in code, env files or the repo.
- Sender: `league@<domain>` once the domain decision is made; SPF + DKIM
  records at the registrar. (Brevo single-verified-sender is the documented
  no-domain alternative, weaker deliverability.)

## Logging discipline

Function logs record: hashed email (first 8 chars of the sha256), outcome
class (`sent | suppressed | limited | provider_error`), idempotency-hash, and
Resend message id. Never: the address, the link, the oob code, or raw IPs.

## Emulator tests (all must exist before deploy)

| Case | Assertion |
|---|---|
| member email | Resend stub called once; generic success; link never in response or logs |
| unknown email | Resend NOT called; byte-identical generic success |
| known email, membership revoked | Resend NOT called; byte-identical generic success |
| enumeration probe | responses for member/unknown/revoked are deep-equal |
| throttling | 4th request in 15 min (same email hash) suppressed; 11th per IP hash suppressed; still generic success |
| provider failure | Resend stub 500s; retries (2, jittered); then generic success + `provider_error` logged redacted |
| duplicate request | same idempotency key twice → one Resend call |
| completion | emailed-link URL format still satisfies `isSignInWithEmailLink` (existing flow untouched) |

## Cost

Resend free tier (3,000/mo, 100/day) vs ~50/mo needed: **£0/month**.
Domain ~£10/year + two DNS records. Secret Manager at this scale: ~£0.
Build effort: one callable + one client line + the test table above.

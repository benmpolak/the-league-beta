# The League — 2026/27

Private draft fantasy Premier League game for twelve managers. Est. 2015. Formerly hosted
on Draft Fantasy (£145 a season to the site); now self-hosted for £0. Vive la révolution.
Forked from the World Cup 2026 build; reskinned for this group.

## What it is
- Snake draft over every Premier League player ("The Console") — pick timer, timewastes, punditry desk, opening ceremony
- Squads of 14, flexible make-up (1–2 GK / 3–6 DF / 3–6 MF / 1–4 FW), **no club cap**
- **Starting XI picked each gameweek** — only starters score (1 GK, 3–5 DF, 2–5 MF, 1–3 FW); lineups lock at the FPL deadline
- **Regular season GW1–33**: head-to-head every week (win 3 / draw 1 / loss 0), 11-round round robin × 3
- **Playoffs**: GW34 semis (1st v 4th, 2nd v 3rd, one leg), GW35–36 two-legged final
- **The Monzo League Cup**: last man standing from GW8 — lowest gameweek score is eliminated, ties roll over
- **Weekly waivers**: one swap each in reverse table order (bottom feeds first); trade desk for agreed swaps
- **Auto-subs**: a starter who never plays is replaced by your best bench player who did (keeps XI shape legal)
- Scoring computed from raw official FPL stats with our own editable table — pen save +5, no captains, no bonus nonsense
- Pure static site on GitHub Pages + Firebase RTDB for multiplayer sync (free tier)

## Data pipeline
- `scripts/fetch_fpl.py` pulls the official FPL API and writes:
  - `js/data.js` — players, clubs, gameweek calendar (loaded synchronously)
  - `data/stats.json` — raw per-player stats per gameweek
  - `data/fixtures.json` — fixtures and scores
- `.github/workflows/fpl.yml` runs it every 15 minutes and commits changes,
  so goals show on the site within ~5–15 minutes on matchdays. No API keys, no accounts.
- `.github/workflows/waivers.yml` (retired at cutover — waivers move to a scheduled
  Cloud Function) ran Tuesday/Friday waivers through the live app. It now no-ops
  unless the repo variable `LEGACY_WAIVERS` is set to `true`.
- Hourly league backups run via `node scripts/backup_league.js` (authenticated with
  a service account — anonymous REST is gone) and snapshot BOTH
  `leagues/the-league-2627` (legacy, `league.json`) and `v2/leagues/the-league-2627`
  (`league-v2.json`, including the private/server subtrees). They are stored as
  private GitHub Actions artifacts for 90 days and deliberately not committed to
  this public repository because they contain manager-only data such as PIN hashes,
  waiver claims and autopick lists.
- The FPL API resets for 26/27 in July 2026 — the same script picks it up automatically.

## How to run the league
1. Open the site — the twelve managers and team names are pre-loaded; correct at setup
2. Hit **Randomise order & start the draft**, run draft night together
3. Every device picks "who are you" once; everything syncs live via Firebase
4. Lineups, waivers and trades happen in **My Team** each gameweek

## Local dev
```
python3 scripts/fetch_fpl.py       # refresh data
python3 -m http.server 8123        # then open http://localhost:8123
```

## Lineage
Forked from `~/worldcup-draft` (see its README). The sync layer, draft console,
scoring engine shape and pomp are all inherited (Moggi stayed behind — different group). Firebase project:
`calciopoli-wc26`, league key `leagues/the-league-2627`.

## Tests
```
npm ci
python3 -m http.server 8125            # from the repo root, then:
npm test                               # syntax + full season + DGW regression suite
node test/e2e.multiclient.js           # 3 real browsers, multi-device fundamentals — port 8140
node test/race.test.js                 # simultaneous-write races — port 8142
node test/stress.test.js               # 8 clients, scrambles, offline/reconnect — port 8143
```
The three multi-client suites use a throwaway league (`leagues/the-league-e2e-test`)
and clean up after themselves. They refuse to start unless you tell them where to
point: set `FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000` to run against the
local emulator (preferred), or `LIVE_DB_TESTS=1` to explicitly acknowledge a run
against the live database. Never point them at the real league key.

## If it all goes wrong (the runbook)
- **Scores stale on a matchday** (amber "feed stale" pill): the FPL fetch Action
  is failing — check Actions. Fallback: `python3 scripts/fetch_fpl.py && git push`
  from any laptop. The site recovers on the next 15-min sync.
- **Somebody wrecked the league state**: download the latest `league-backup-*`
  artifact from the Backup league state Action, then (with
  `GOOGLE_APPLICATION_CREDENTIALS` pointing at a service-account key) run
  `node scripts/restore_league.js /path/to/league.json` — a file named
  `league-v2.json` restores the v2 tree, anything else the legacy tree. Older
  artifacts remain available for 90 days. Wipe protection still requires the
  two-step reset ritual.
- **Firebase dies or the Google account is lost**: create a new Firebase project
  (free), change `databaseURL` + deploy `database.rules.json`, restore from the
  latest backup. One line in `js/sync.js` points the app at the new home.
- **GitHub dies**: the repo is a full copy on every machine that ever cloned it;
  Pages can be re-enabled on any fork in minutes.
- **Mid-draft disaster**: the draft state is in Firebase and localStorage on every
  device — reload and carry on. The Chairman has Pause and Undo-last-pick.

## Known limitations (honest list)
Found in a four-way deep audit (Jul 2026). The league-breakers were all fixed;
these two are deferred because they need bigger changes or can't be tested until
the situation arises. Neither affects a normal single-gameweek week.

- **Manual point adjustments** (Settings) currently only nudge the cosmetic
  season-points total, not H2H results. To make a stat correction actually
  change a result it needs to be per-gameweek and folded into `gwPlayerPoints`.
  Until then, prefer fixing the source: the feed self-corrects on the next sync.
- **A fully-postponed gameweek** (zero stats ever recorded) would leave the
  playoffs/cup waiting on it. Rare, but if it happens the commissioner can
  advance things manually. Worth a proper "void this GW" control before it bites.

## Secrets
- **`FIREBASE_SERVICE_ACCOUNT`** (GitHub Actions secret): the JSON of a service
  account with Editor on `calciopoli-wc26`. Get it from the Firebase console:
  Project settings → Service accounts → Generate new private key, then paste the
  whole file into the secret. The backup workflow fails loudly without it; the
  key is written outside the checkout at runtime and shredded afterwards. For
  local backup/restore runs, point `GOOGLE_APPLICATION_CREDENTIALS` at the same
  file (kept OUTSIDE the repo).
- **`LEGACY_WAIVERS`** (repo variable, not a secret): set to `true` only to
  re-enable the retired puppeteer waiver workflow as a fallback. Leave unset
  once the scheduled Cloud Function is live.

## Deploying the database rules
`database.rules.json` is deployed separately from the site (GitHub Pages only
serves static files). After editing it:
```
npx firebase-tools deploy --only database
```
At cutover, `database.rules.v2.json` replaces `database.rules.json` (see
MIGRATION-RUNBOOK.md) — from then on clients cannot write the database at all,
so the old SHARED_KEYS/rules lockstep concern disappears: writes only happen in
`functions/index.js` via the Admin SDK, and the emulator suites are the check.

## Going authenticated — one-time Firebase console steps (Ben)
Everything else is scripted; these five can only be done by a human with owner
access on the `calciopoli-wc26` project (console.firebase.google.com):

1. **Upgrade to the Blaze plan** (pay-as-you-go). Cloud Functions and Cloud
   Scheduler require it. At 12 users the bill rounds to £0 most months; set a
   budget alert at £5 while you're in there.
2. **Enable Email link sign-in**: Authentication → Sign-in method → Email/Password
   → enable, and tick "Email link (passwordless sign-in)".
3. **Authorise the site domain**: Authentication → Settings → Authorized domains
   → add `benmpolak.github.io`.
4. **Service account key** (backups, provisioning, migration): Project settings
   → Service accounts → Generate new private key. Store it outside the repo;
   paste its JSON into the `FIREBASE_SERVICE_ACCOUNT` GitHub Actions secret.
5. **After everything works — App Check**: register the site with reCAPTCHA v3
   (App Check → Apps), then enforce for Realtime Database and Functions. Do this
   LAST and only once sign-in has been stable for a week. App Check hardens
   against abusive scripts; it is not a substitute for the auth above.

Then, from the repo (CLI is already logged in):
```
node scripts/provision_managers.js --live        # after filling managers.local.json
npx firebase-tools deploy --only functions       # the mutation layer + waiver cron
```
and follow MIGRATION-RUNBOOK.md for the rules cutover.

## Remaining risks after v2 (honest list)
- **The FPL data feed is trusted.** Functions score and validate against
  `js/data.js` / `data/stats.json` served from GitHub Pages; whoever can push to
  this repo can influence scoring. Mitigation: repo access is Ben only, the feed
  is generated by a pinned Action, and waivers refuse to run on a feed older
  than 90 minutes.
- **The commissioner account is powerful.** Real auth means it's Ben's email,
  not a PIN — but a compromised commissioner mailbox could import state or
  reset the league. Hourly backups + the restore script are the recovery path.
- **Email-link sign-in is only as strong as each manager's mailbox.** That is
  the accepted trade-off of passwordless; it is still categorically better than
  a 4-digit PIN in a world-readable database.
- **Lineups are public in real time** (league tradition, matches Draft Fantasy).
  Blind waiver claims and autopick lists are the private data, and only those.
- **App Check is deferred** until after launch week (step 5 above), so
  scripted-abuse hardening lags the auth cutover slightly.

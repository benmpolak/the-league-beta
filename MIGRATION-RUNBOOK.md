# v2 Migration Runbook

Moving `leagues/the-league-2627` (open, trust-the-browser) to the authenticated
`v2/leagues/the-league-2627/{public,private,server}` schema. One-way door with a
documented way back. Read the whole thing once before touching anything.

Every command below references a script that exists in this repo. Nothing in
this runbook copies files over other files, and nothing commits a backup —
v2 backups hold manager-private data and live only as encrypted CI artifacts
or local files outside git.

## 0. Stop conditions

Abort (and, if past step 6.2, run the rollback in §9) if at ANY point:

- a dry-run or rehearsal report says anything other than `RESULT: PASS`
- `node scripts/backup_league.js` exits non-zero or writes no `manifest.json`
- a deploy command reports partial failure
- the smoke checks in §8 fail and 15 minutes of looking hasn't explained why
- you are doing this on a matchday within 3 hours of kickoff (don't)

## 1. Prerequisites (all of these, before anything)

1. Firebase console steps done (README → "Going authenticated"): Blaze plan,
   Email-link sign-in enabled, `benmpolak.github.io` authorised, service
   account key generated. App Check waits until after launch week.
2. GitHub Actions secrets set: `FIREBASE_SERVICE_ACCOUNT` (the service-account
   JSON) and `BACKUP_PASSPHRASE` (encrypts v2 backup artifacts — put it in a
   password manager; a backup you can't decrypt is not a backup).
3. `managers.local.json` filled with the 12 real emails (it is gitignored;
   the shape is in `managers.local.example.json` and the header of
   `scripts/provision_managers.js`).
4. The service-account JSON saved OUTSIDE the repo, referenced below as
   `service-account.json`.
5. CI green on the branch you are deploying (browser + emulator jobs).

## 2. Emulator rehearsal (no credentials, no risk)

```
npm ci && npm i --prefix functions
npm run test:emu    # rules + functions + migrate + backup + provision suites
                    # (the suites generate and serve their own synthetic feed)
```

Then rehearse provisioning itself against the emulator:

```
npx firebase-tools emulators:start --config firebase.emu.json --project calciopoli-wc26 &
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000 \
node scripts/provision_managers.js
```

Expect a JSON report with all 12 managers and `"target": "emulator"`.

## 3. Live provisioning (safe before cutover — writes only `v2/.../server`)

```
GOOGLE_APPLICATION_CREDENTIALS=service-account.json \
node scripts/provision_managers.js --live
```

Verify: every manager listed with a uid, Ben's entry says `commissioner`.
Re-running is idempotent. Pruning a manager later (edit the file, re-run)
removes their membership, rebuilds the managerId→uid map and clears their
league claims — stale tokens grant nothing either way, the server checks
membership on every call.

## 4. Sandbox rehearsal (live project, fake league)

The sandbox league lets you rehearse the full authenticated experience without
touching the real league:

1. Deploy functions: `npm run deploy:functions` (type `DEPLOY-FUNCTIONS`).
2. Open `https://benmpolak.github.io/the-league/?sandbox` from the auth-v2
   client build, sign in with your real email, claim your team, save a lineup,
   lodge a claim. (Pre-cutover the legacy rules are still live, so the v2
   subtree is already writable only by the server — this is the real security
   model.)
3. If the real league has data to migrate (see §6.4 — as of Jul 2026 the legacy
   node is EMPTY and this is moot), rehearse the migration against the sandbox:
   ```
   GOOGLE_APPLICATION_CREDENTIALS=service-account.json \
   node scripts/migrate_v2.js --snapshot <backup>.json \
     --live --i-have-a-backup --target-league the-league-sandbox
   ```

## 5. Backup + verify (no backup, no cutover)

```
GOOGLE_APPLICATION_CREDENTIALS=service-account.json \
node scripts/backup_league.js
```

Verify before proceeding:

- exit code 0, `ok [legacy]` and `ok [v2]` lines printed
- `data/backups/manifest.json` exists and its counts look like your league
  (12 managers etc.) — this file is the shrink-detection baseline
- do NOT commit anything from `data/backups/` (the directory is for local use;
  CI keeps its own encrypted artifacts)

## 6. Cutover (in this order)

There is no maintenance flag on the old world — the rules deploy IS the freeze.

1. Confirm out loud: WC26 is over, prerequisites §1 are done, §5 backup is
   fresh (within the hour).
2. Freeze the legacy world by deploying the v2 rules:
   ```
   npm run deploy:cutover-rules        # shows the rules file + hash, type CUTOVER
   ```
   From this second, all legacy writes fail — the old client goes read-only
   until step 7. The deploy command names `firebase.cutover.json` explicitly
   and refuses to run if that config does not point at `database.rules.v2.json`.
3. Take the definitive post-freeze snapshot (reads still work):
   ```
   GOOGLE_APPLICATION_CREDENTIALS=service-account.json \
   node scripts/backup_league.js
   ```
4. Migrate the data — ONLY if the legacy node holds a real league. (It was
   empty as of Jul 2026 — the league never seeded — in which case skip this
   step; there is nothing to migrate.)
   ```
   GOOGLE_APPLICATION_CREDENTIALS=service-account.json \
   node scripts/migrate_v2.js --snapshot data/backups/league.json --live --i-have-a-backup
   ```
   The report must end `RESULT: PASS`, `checksums: MATCH`. Keep
   `data/migration-report.txt` with the cutover commit. Idempotent — a flaky
   connection mid-write is fixed by running it again.
5. Deploy the functions (if not already at the current build):
   ```
   npm run deploy:functions
   ```

## 7. Point the league at the new world

Merge/push the auth-v2 client to `main` (the usual Pages deploy). Tell the
lads to refresh and sign in.

## 8. Smoke checks (all of them, immediately)

- `curl` the public node: readable without auth, phase/managers present
  (`https://calciopoli-wc26-default-rtdb.europe-west1.firebasedatabase.app/v2/leagues/the-league-2627/public.json`)
- sign in as yourself on the live site: membership arrives, you are named
- save a lineup for a future GW: succeeds; the change appears on a second
  device without a refresh
- try a write to the legacy path (old client or curl PUT): rejected
- `gh run list` — the next hourly backup run is green (it now snapshots v2
  with real content and uploads an encrypted artifact)

## 9. Rollback (if it goes wrong, in this order)

1. Re-open the legacy world:
   ```
   npm run rollback:legacy-rules       # names firebase.rollback-legacy.json, type ROLLBACK
   ```
   Legacy writes work again immediately.
2. If the legacy DATA was damaged (it should not have been — nothing in §6
   writes to `leagues/...`), restore the pre-cutover snapshot explicitly:
   ```
   GOOGLE_APPLICATION_CREDENTIALS=service-account.json \
   node scripts/restore_league.js data/backups/league.json --schema legacy --league the-league-2627
   ```
3. Remove the half-built v2 game state if you want a clean slate for the next
   attempt (keeps `server/` provisioning):
   ```
   GOOGLE_APPLICATION_CREDENTIALS=service-account.json \
   node scripts/rollback_v2.js data/backups/league.json --live
   ```
   (It prompts before every destructive step; skip the v2 delete if you want
   the node kept for a post-mortem.)
4. Re-deploy the old client if it was already replaced. Tell the lads to
   refresh.

## Notes

- Restores never infer the target from a filename: `--schema legacy|v2` and
  `--league <key>` are required, and the file must actually look like the
  schema you declared.
- CI v2 artifacts are encrypted. To use one:
  `openssl enc -d -aes-256-cbc -pbkdf2 -in league-v2.json.enc -out league-v2.json`
  (passphrase = the `BACKUP_PASSPHRASE` secret).
- Migration owns the whole `v2/.../private` node: a live run overwrites it
  wholesale. Fine at cutover; do not re-run casually once managers have
  written their own claims in v2.
- All scripts use the admin SDK only. If something asks you for a plain REST
  workaround, the answer is no.

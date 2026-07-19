# v2 Migration Runbook

Moving `leagues/the-league-2627` (open, trust-the-browser) to the authenticated
`v2/leagues/the-league-2627/{public,private,server}` schema. One-way door with a
documented way back. Read the whole thing once before touching anything.

**DO NOT CUT OVER BEFORE THE WC26 FINAL IS DONE (finishes 19 Jul 2026).**
The World Cup game lives in the same RTDB under the same rules file. The rules
deploy in step 6 freezes ALL legacy writes — it would kill that game's client
mid-final. Wait until it's over.

## 1. Prerequisites

- Service account JSON downloaded from the Firebase console (project
  `calciopoli-wc26`). Keep it out of the repo. Referenced below as
  `service-account.json`.
- Managers provisioned: `node scripts/provision_managers.js --live` has run
  clean (it writes `server/membership` and `server/managerUid` for both
  leagues). Rehearse it against the emulator first — see its header.
- Emulator rehearsal of the migration itself (step 4) done at least once.
- A fresh backup committed (step 5). No backup, no migration — the script
  literally refuses.

## 2. Dry-run

```
GOOGLE_APPLICATION_CREDENTIALS=service-account.json \
node scripts/migrate_v2.js --fetch
```

Or offline from a backup file (uid map exported to a local JSON
`{"1": "uid...", ...}`):

```
node scripts/migrate_v2.js --snapshot data/backups/league.json --uid-map uidmap.local.json
```

Nothing is written in either case. A good report (stdout and
`data/migration-report.txt`) looks like:

- every legacy key listed as present (or `null` for hamCup/windowDraft if unused)
- `pins: dropped (N entries)` — expected, PINs are replaced by real auth
- every verification line `OK`, counts identical on both sides
- `deep-equal: OK`, `checksums: MATCH`
- `RESULT: PASS`

Anything else: stop, fix, re-run. The script exits nonzero and will not write
on a failed verification. A common failure is a manager with claims or an
autolist missing from the uid map — that means provisioning hasn't run or is
incomplete.

## 3. Emulator rehearsal

```
FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000 \
node scripts/migrate_v2.js --snapshot data/backups/league.json --emulator
```

Seed the emulator, run provisioning against it, migrate, poke the result.
The script refuses `--live` while emulator vars are set, and vice versa.

## 4. Sandbox rehearsal (live DB, fake league)

```
GOOGLE_APPLICATION_CREDENTIALS=service-account.json \
node scripts/migrate_v2.js --snapshot data/backups/league.json \
  --live --i-have-a-backup --target-league the-league-sandbox
```

Writes only under `v2/leagues/the-league-sandbox`. Open the new client with
`?sandbox` and check sign-in, claims, autolists.

## 5. Backup

```
python3 scripts/backup_league.py
git add data/backups/league.json && git commit -m "pre-migration snapshot"
```

If it prints an ALERT instead of `ok:`, do not proceed.

## 6. Cutover (in this order)

There is no maintenance flag on the old world — the rules deploy IS the freeze.

1. Confirm the WC26 final is finished. Not "nearly". Finished.
2. Copy `database.rules.v2.json` over `database.rules.json`, commit, then:
   ```
   npx firebase-tools deploy --only database
   ```
   From this second, all legacy writes fail — including the OLD site build.
   The lads will see a dead app until step 8. Legacy stays readable.
3. Take the definitive snapshot (reads still work):
   ```
   python3 scripts/backup_league.py
   git add data/backups/league.json && git commit -m "cutover snapshot"
   ```
4. Migrate exactly what you just backed up:
   ```
   GOOGLE_APPLICATION_CREDENTIALS=service-account.json \
   node scripts/migrate_v2.js --snapshot data/backups/league.json --live --i-have-a-backup
   ```
   Writes only `v2/leagues/the-league-2627/{public,private}` plus
   `server/maintenance=false`. Never touches `leagues/...` or the rest of
   `server/`. Idempotent — re-running from the same snapshot produces the
   identical result, so a flaky connection mid-write is fixed by running again.

## 7. Verify

- Report says `RESULT: PASS`, `checksums: MATCH`. Keep
  `data/migration-report.txt` with the cutover commit.
- `v2/.../public` readable without auth (curl it); counts match the report.
- `v2/.../server/maintenance` is `false`.
- Sign in on the new client as yourself: your autolist and claims are there;
  you cannot read anyone else's `private/<uid>`.
- Old site: loads read-only or errors on write — either is fine, it's retired.

## 8. Point the league at the new world

Deploy the new client to Pages (the usual push-to-main deploy). Tell the lads
to refresh and sign in. Done.

## 9. Rollback

If it goes wrong, in this order:

1. Restore the legacy rules file from git history and deploy it:
   ```
   git checkout <pre-cutover-commit> -- database.rules.json
   npx firebase-tools deploy --only database
   ```
   Legacy writes work again immediately (rules first, or the restored data
   stays frozen).
2. Restore data and remove the half-built v2 node:
   ```
   GOOGLE_APPLICATION_CREDENTIALS=service-account.json \
   node scripts/rollback_v2.js data/backups/league.json --live
   ```
   It asks you to type `RESTORE` (overwrites `leagues/the-league-2627` from
   the backup) and then `DELETE-V2` (removes `v2/leagues/the-league-2627`).
   Skip the delete if you want the v2 node kept for a post-mortem.
3. Re-deploy the old client if it was already replaced. Tell the lads to
   refresh.

## Notes

- Migration owns the whole `v2/.../private` node: a live run overwrites it
  wholesale. Fine at cutover; do not re-run casually once managers have
  written their own claims in v2.
- `scripts/backup_league.py` still snapshots the legacy path after cutover
  (readable but frozen, so it never changes). Pointing backups at v2 is part
  of the client/functions work, not this runbook.
- All scripts use the admin SDK only. If something asks you for a plain REST
  workaround, the answer is no.

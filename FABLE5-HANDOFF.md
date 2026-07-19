# Fable 5 handoff: make Firebase genuinely private and server-authoritative

You are working on Ben Polak's private 12-manager fantasy football game at
`/Users/benpolak/the-league`. Read the whole repo before editing. Preserve the
league's tone and rules. This is an implementation task, not an architecture memo.

## Outcome

Replace the current trust-the-browser Firebase model with authentication and
server-authoritative mutations so the game is no worse than Draft Fantasy on
privacy, identity, concurrency or scheduled jobs. Deploy only after the emulator
and migration checks pass. Do not reset or mutate the live league while building.

## Current risks you must remove

- `database.rules.json` allows public reads and effectively permits any visitor to
  write an existing league. Client-side `whoami` and PIN checks are not security.
- PIN hashes, private waiver claims and autopick lists sit in the shared league
  snapshot. Any reader can inspect them; 4-digit PIN hashes are trivial to brute-force.
- All consequential writes are initiated by browser code. Firebase transactions
  prevent some races but cannot prove who the actor is or enforce commissioner powers.
- The waiver Action impersonates the commissioner by opening the public app.
- Backup/restore scripts rely on unauthenticated REST access.

## Non-negotiable design

1. Use Firebase Authentication with passwordless email-link sign-in for the 12
   managers. Spectators may see an explicitly public, read-only subset without auth.
   Do not put manager email addresses in the repository or public database paths.
2. Provision manager membership server-side. Map Firebase `uid` to `managerId` and
   role (`manager` or `commissioner`) using custom claims or a server-owned membership
   node that clients cannot write. Add an idempotent provisioning script that reads
   emails from an ignored local JSON file or environment variable.
3. Remove PIN authentication and migrate existing signed-in devices cleanly. A user
   with only the old localStorage identity must be asked to sign in; it must not grant
   authority after migration.
4. Split public league data from private manager data. Autopick lists, pending waiver
   claims, unpublished lineups and any private trade drafts must be readable only by
   their owner and the server. Do not send the entire private league snapshot to every
   browser.
5. Move all consequential mutations behind authenticated server code (Firebase
   callable/HTTPS Functions or an equivalent server-authoritative layer): draft pick,
   undo/pause/restart, lineup save, waiver claim/reorder/delete, trough signing,
   trade propose/respond/withdraw, commissioner settings, identity administration,
   point adjustments, window draft and reset/restore. The server must derive the actor
   from the verified auth token, never from a request-supplied `managerId` alone.
6. Keep real-time reads so the draft board and scores update immediately. Mutation
   responses must be idempotent and use database transactions where races are possible.
7. Replace the browser-based scheduled waiver runner with a scheduled server function.
   It must be idempotent, record a run ID/status/result, retry safely and expose failure
   clearly. Exactly one run may process a due window.
8. Lock down Realtime Database rules: deny by default; public read only on the explicit
   public subtree; authenticated per-user read on private data; no direct client writes
   to server-owned state. Add emulator rule tests proving cross-manager reads/writes and
   commissioner impersonation fail.
9. Update backup and restore to use Firebase Admin credentials stored as GitHub Actions
   secrets. Backups remain private Actions artifacts. Never commit credentials, emails,
   auth exports, PIN hashes, claims or autopick lists.
10. Add App Check after Auth works, but do not pretend App Check replaces user auth.

## Rollout and migration

- Build against the Firebase Emulator Suite first.
- Add a migration script that reads the existing `leagues/the-league-2627` snapshot,
  writes the new shape to a separate versioned path, verifies counts/checksums, and
  produces a redacted report. It must default to dry-run and require an explicit flag
  for any live write.
- Preserve every manager, draft pick, lineup, transfer, trade, covenant, setting,
  adjustment, cup state and historical score. Remove `pins` after accounts are mapped.
- Provide a rollback procedure that restores the pre-migration snapshot.
- Use a short maintenance flag during cutover so old clients cannot write. Force stale
  builds to reload. Do not run two writable schemas at once.
- Update the PWA/CSP for Firebase Auth and Functions domains without broad `*` sources.

## Required tests

- Firebase rules emulator: anonymous public read is limited; manager A cannot read or
  change manager B's private data; a manager cannot perform commissioner actions;
  client direct writes to server-owned state fail.
- Auth: valid email-link flow, unknown email rejection, sign-out, expired link and
  restored session.
- Draft: two simultaneous picks yield one legal pick; timer/autopick remains idempotent.
- Transfers: same-player race has one winner; different-player concurrent signings both
  survive; invalid squad changes fail server-side.
- Waivers: deterministic order, one scheduled run, safe retry, no partial claim clearing.
- Migration: dry-run parity report and round-trip against a fixture snapshot.
- Existing `npm test` remains green. Add the new emulator/integration suite to CI; tests
  must never point at the real league unless an explicit protected deploy job is used.

## Deliverables

- Working code, rules, functions, migrations, provisioning and tests.
- Updated README with exact one-time Firebase console steps Ben must perform, limited to
  unavoidable account/domain/secret configuration.
- A short `MIGRATION-RUNBOOK.md` with dry-run, backup, cutover, verification and rollback.
- A redacted list of any remaining risks. Do not claim completion if live Firebase rules
  are still public or writes still trust `localStorage` identity.

Before touching live Firebase, show Ben the passing emulator output and the dry-run
migration report, then ask for the single explicit cutover approval.

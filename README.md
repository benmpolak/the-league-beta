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
python3 -m http.server 8125            # from the repo root, then:
node test/sim.test.js                  # full 26/27 season, 57 checks (offline engine)
node test/e2e.multiclient.js           # 3 real browsers vs live Firebase (throwaway league) — port 8140
node test/race.test.js                 # simultaneous-write races — port 8142
node test/stress.test.js               # 8 clients, scrambles, offline/reconnect — port 8143
node test/dgw.test.js                  # double-gameweek per-fixture scoring (real GW26 data)
```
The live-Firebase suites use `leagues/the-league-e2e-test` and clean up after
themselves. Never point them at the real league key.

## If it all goes wrong (the runbook)
- **Scores stale on a matchday** (amber "feed stale" pill): the FPL fetch Action
  is failing — check Actions. Fallback: `python3 scripts/fetch_fpl.py && git push`
  from any laptop. The site recovers on the next 15-min sync.
- **Somebody wrecked the league state**: hourly snapshots live in `data/backups/`.
  `python3 scripts/restore_league.py` puts the last good one back. Wipe protection
  means the league can't be deleted without the two-step reset ritual.
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

## Deploying the database rules
`database.rules.json` is deployed separately from the site (GitHub Pages only
serves static files). After editing it:
```
npx firebase-tools deploy --only database
```
IMPORTANT: `SHARED_KEYS` in `js/app.js` and the per-key rules in
`database.rules.json` must stay in lockstep — a multi-key `publishAll()` write
is all-or-nothing, so a key present in one but not the other silently breaks
every publish. Verify a deploy with `node test/e2e.multiclient.js` (it exercises
every write path against the live rules on a throwaway league).

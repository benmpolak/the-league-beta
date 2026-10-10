#!/usr/bin/env python3
"""Fetch FPL data and regenerate the site's data files.

Outputs:
  js/data.js         TEAMS / PLAYERS / GAMEWEEKS (loaded synchronously by the app)
  data/stats.json    raw per-player stats per gameweek (fetched at runtime)
  data/fixtures.json PL fixture list with scores

Run by the GitHub Action on a schedule; safe to run locally any time.
"""
import json
import time
import urllib.request
from pathlib import Path

import provisional  # Committee-issued players the FPL feed has not ingested yet

BASE = 'https://fantasy.premierleague.com/api'
ROOT = Path(__file__).resolve().parent.parent
POS = {1: 'GK', 2: 'DF', 3: 'MF', 4: 'FW'}


def get(url, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'the-league/1.0'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception:
            if i == retries - 1:
                raise
            time.sleep(2 * (i + 1))


def snapshot_team_news(players, gameweeks, now=None):
    """Preserve the team news as it stood going into each deadline.

    `chance_of_playing_next_round` means exactly that — NEXT round. Every
    refresh overwrites it, so once a deadline passes there is no record
    anywhere that a man was ever doubtful before it. That makes it the one
    input to the projection that cannot be reconstructed after the fact, and
    without it there is no honest way to ask later how good the projection was
    (Marc, 24 Aug 2026 — the calibration ledger).

    So: rewrite the open round's row on every run, and freeze it the moment the
    deadline passes. The last write before lock-out is the real final team
    news. Rounds already closed are never touched again.

    Only men carrying something worth remembering are stored — a flag, a
    percentage, or a news line. Everyone else is available and unremarkable,
    which the absence of a row already says.
    """
    import datetime as dt
    now = now or dt.datetime.now(dt.timezone.utc)
    path = ROOT / 'data' / 'teamnews.json'
    try:
        book = json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        book = {}          # first run, or a file we cannot read: start clean
    rounds = book.setdefault('rounds', {})

    # the open round: the first whose deadline is still ahead of us
    nxt = None
    for g in gameweeks:
        try:
            when = dt.datetime.fromisoformat(g['deadline'].replace('Z', '+00:00'))
        except Exception:
            continue
        if when > now:
            nxt = (str(g['n']), when)
            break

    if nxt:
        key, when = nxt
        row = {}
        for p in players:
            status = p.get('status') or 'a'
            chance = p.get('chance')
            news = p.get('news') or ''
            if status == 'a' and chance is None and not news:
                continue
            entry = {'s': status}
            if chance is not None:
                entry['c'] = chance
            if news:
                entry['n'] = news[:120]
            row[str(p['id'])] = entry
        rounds[key] = {
            'deadline': when.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'taken': now.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'flagged': row,
        }

    book['note'] = ('Team news as it stood going into each deadline. Written by '
                    'scripts/fetch_fpl.py; the open round is refreshed until its '
                    'deadline passes and frozen after. Do not edit by hand.')
    path.write_text(json.dumps(book, ensure_ascii=False, sort_keys=True), encoding='utf-8')
    return len(rounds)


def main():
    boot = get(f'{BASE}/bootstrap-static/')

    teams = [{
        'id': t['id'],
        'name': t['name'],
        'short': t['short_name'],
        'code': t['code'],
        # blended FPL strength rating, used for fixture-ease in the weekly preview
        'str': round((t['strength_overall_home'] + t['strength_overall_away']) / 2),
    } for t in boot['teams']]
    team_name = {t['id']: t['name'] for t in teams}
    team_short = {t['id']: t['short_name'] for t in boot['teams']}

    players = []
    for e in boot['elements']:
        if e['element_type'] not in POS:  # skip assistant-manager elements
            continue
        pts = e.get('total_points') or 0
        players.append({
            'id': e['id'],
            'name': e['web_name'],
            'full': f"{e['first_name']} {e['second_name']}".strip(),
            'team': team_name[e['team']],
            'club': team_short[e['team']],
            'pos': POS[e['element_type']],
            'code': e['code'],
            'status': e['status'],           # a/d/i/s/u
            'news': e.get('news') or '',
            # when the news line last changed + chance of playing, for the Treatment Room
            'newsAdded': e.get('news_added') or '',
            'chance': e.get('chance_of_playing_next_round'),
            'price': e['now_cost'] / 10,
            'pts': pts,
            # draft-room guide: points if the season has any, else price as proxy
            'rating': pts if pts > 0 else round(e['now_cost'] / 10),
            # FPL's own expected points for the next gameweek — feeds projections
            'xp': float(e.get('ep_next') or 0),
            'ppg': float(e.get('points_per_game') or 0),
            # season aggregates for the pool table and player cards
            'mp': e.get('minutes') or 0,
            'g': e.get('goals_scored') or 0,
            'a': e.get('assists') or 0,
            'cs': e.get('clean_sheets') or 0,
            'xg': float(e.get('expected_goals') or 0),
            'xa': float(e.get('expected_assists') or 0),
            # Marc, 10 Aug: xGC plus the per-90 variants FPL already publishes.
            # Per-90 compares a squad player to a nailed starter fairly, which
            # raw season totals cannot. xGOT is deliberately absent — FPL has no
            # on-target field; it would need an Opta-derived source.
            'xgc': float(e.get('expected_goals_conceded') or 0),
            'xg90': float(e.get('expected_goals_per_90') or 0),
            'xa90': float(e.get('expected_assists_per_90') or 0),
            'xgi90': float(e.get('expected_goal_involvements_per_90') or 0),
            'xgc90': float(e.get('expected_goals_conceded_per_90') or 0),
            # PL country id — the app maps it to a flag (academy kids ship null)
            'nat': e.get('region'),
        })

    # a signing can be announced days before the FPL API admits he exists.
    # data/provisional.json carries him until it does — merged HERE so the
    # client (js/data.js) and the server (data/data.json) get him from one
    # source, and so a scheduled refresh can never quietly drop him.
    players = provisional.merge(players)

    # ...and a man the feed HAS, at a club he has left, is the same disease.
    # data/moved.json states where he actually plays; correcting it here puts
    # him in the holding pen by the ordinary rule, with no special case
    # downstream (Marc, 2 Sept 2026 — Tosin, on deadline day).
    players, moved_notes = provisional.apply_moves(players, teams)
    for n in moved_notes:
        print(f'  moved: {n}')

    events = boot['events']
    gameweeks = []
    for i, ev in enumerate(events):
        nxt = events[i + 1]['deadline_time'] if i + 1 < len(events) else None
        gameweeks.append({
            'n': ev['id'],
            'label': ev['name'],
            'deadline': ev['deadline_time'],
            'to': nxt or ev['deadline_time'][:10] + 'T23:59:59Z',
            'finished': ev['finished'],
        })
    # last GW has no successor: give its window a week after the deadline
    if gameweeks:
        import datetime as dt
        d = dt.datetime.fromisoformat(gameweeks[-1]['deadline'].replace('Z', '+00:00'))
        gameweeks[-1]['to'] = (d + dt.timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ')

    header = f"// Generated by scripts/fetch_fpl.py — do not edit by hand.\n// Source: official FPL API. Season: {boot['events'][0]['deadline_time'][:4]}/{int(boot['events'][0]['deadline_time'][:4]) % 100 + 1}.\n"
    data_js = (
        header
        + 'const TEAMS = ' + json.dumps(teams, ensure_ascii=False) + ';\n'
        + 'const PLAYERS = ' + json.dumps(players, ensure_ascii=False) + ';\n'
        + 'const GAMEWEEKS_RAW = ' + json.dumps(gameweeks, ensure_ascii=False) + ';\n'
    )
    (ROOT / 'js' / 'data.js').write_text(data_js, encoding='utf-8')

    # pure-JSON mirror of data.js for the server (Cloud Functions parse this as
    # data — they never execute fetched code)
    (ROOT / 'data' / 'data.json').write_text(json.dumps({
        'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'teams': teams,
        'players': players,
        'gameweeks': gameweeks,
    }, ensure_ascii=False), encoding='utf-8')

    # fixtures
    fx = get(f'{BASE}/fixtures/')
    fixtures = [{
        'id': f['id'],
        'gw': f.get('event'),
        'date': f.get('kickoff_time'),
        'home': team_name.get(f['team_h'], '?'),
        'away': team_name.get(f['team_a'], '?'),
        'hs': f.get('team_h_score'),
        'as': f.get('team_a_score'),
        'started': bool(f.get('started')),
        'finished': bool(f.get('finished')),
        # FPL's `finished` waits HOURS for bonus/data checks (ARS-COV sat
        # "live" for 12h on GW1 night); finished_provisional flips at the
        # whistle. Display surfaces use fp; settlement keeps the slow flag.
        'fp': bool(f.get('finished_provisional')),
        'minutes': f.get('minutes') or 0,
    } for f in fx]
    (ROOT / 'data' / 'fixtures.json').write_text(
        json.dumps(fixtures, ensure_ascii=False), encoding='utf-8')

    # per-GW raw stats — only GWs that have started
    current = next((ev['id'] for ev in events if ev['is_current']), None)
    gws = {}
    for ev in events:
        if not (ev['finished'] or ev['is_current'] or (ev.get('data_checked'))):
            continue
        live = get(f'{BASE}/event/{ev["id"]}/live/')
        # FPL identifier -> our short key, for reading the per-fixture `explain`
        EXPLAIN_MAP = {
            'minutes': 'min', 'goals_scored': 'g', 'assists': 'a',
            'clean_sheets': 'cs', 'goals_conceded': 'gc', 'own_goals': 'og',
            'penalties_saved': 'ps', 'penalties_missed': 'pm',
            'yellow_cards': 'yc', 'red_cards': 'rc', 'saves': 'sv',
        }
        stats = {}
        for el in live['elements']:
            s = el['stats']
            if s['minutes'] == 0 and not any([s['yellow_cards'], s['red_cards']]):
                continue
            # st = number of STARTS in the gameweek (feeds the start-2 / sub-1
            # appearance rule; can be 2+ in a double gameweek)
            started = s.get('starts', 1 if s['minutes'] >= 60 else 0)
            row = {
                'min': s['minutes'],
                'st': int(started),
                'sub': 1 if (s['minutes'] > 0 and not started) else 0,
                'g': s['goals_scored'],
                'a': s['assists'],
                'cs': s['clean_sheets'],
                'gc': s['goals_conceded'],
                'og': s['own_goals'],
                'ps': s['penalties_saved'],
                'pm': s['penalties_missed'],
                'yc': s['yellow_cards'],
                'rc': s['red_cards'],
                'sv': s['saves'],
            }
            # double gameweek: the aggregate above mis-scores per-match rules
            # (appearance, goals-conceded per 2, saves per 3). Store each fixture
            # separately so the app can score match-by-match and sum. Any stat
            # absent from a fixture's explain scored 0 that match, so 0 is right.
            explain = el.get('explain') or []
            if len(explain) >= 2:
                fx = []
                for ex in explain:
                    fs = {'min': 0, 'g': 0, 'a': 0, 'cs': 0, 'gc': 0, 'og': 0,
                          'ps': 0, 'pm': 0, 'yc': 0, 'rc': 0, 'sv': 0}
                    for st in ex.get('stats', []):
                        k = EXPLAIN_MAP.get(st['identifier'])
                        if k:
                            fs[k] = st['value']
                    fx.append(fs)
                row['fx'] = fx
            stats[el['id']] = row
            # xG, xA and xGC per gameweek (Marc, 10 Oct 2026: "i want to see if
            # a players high xg is in one game or many, is recent, or was ages
            # ago"). The feed only ever gave a season-to-date total, so a window
            # over it showed the same number whatever you asked for.
            #
            # Take them off the live response when it carries them — those are
            # per-round figures that re-read correctly if FPL revises a score
            # later. The endpoint has not always had them, so nothing here
            # assumes it does: an absent field is left absent and the preserve
            # pass below keeps whatever was already reconstructed.
            for key, field in (('xg', 'expected_goals'), ('xa', 'expected_assists'),
                               ('xgc', 'expected_goals_conceded')):
                if field in s:
                    try:
                        v = round(float(s[field] or 0), 2)
                    except (TypeError, ValueError):
                        continue
                    if v > 0:
                        row[key] = v
        gws[str(ev['id'])] = {'finished': ev['finished'], 'stats': stats}

    # Keep per-gameweek xG that this run could not produce itself.
    #
    # This file is rebuilt from scratch every few minutes. Rounds 1-5 of 26/27
    # were played before anything stored xG per round, so they were rebuilt off
    # this repo's own history by scripts/backfill_xg.js — and without this pass
    # the very next refresh would throw that away again. Only ever fills a gap:
    # a figure the live response gave us above always wins.
    try:
        old = json.loads((ROOT / 'data' / 'stats.json').read_text(encoding='utf-8'))
        for gw_key, old_gw in (old.get('gws') or {}).items():
            new_gw = gws.get(gw_key)
            if not new_gw:
                continue
            for pid, old_row in (old_gw.get('stats') or {}).items():
                new_row = new_gw['stats'].get(int(pid)) or new_gw['stats'].get(pid)
                if not new_row:
                    continue
                for key in ('xg', 'xa', 'xgc'):
                    if key in old_row and key not in new_row:
                        new_row[key] = old_row[key]
    except (OSError, ValueError):
        pass        # no previous file, or it is unreadable: nothing to preserve

    (ROOT / 'data' / 'stats.json').write_text(json.dumps({
        'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'currentGw': current,
        'gws': gws,
    }, ensure_ascii=False), encoding='utf-8')

    news_rows = snapshot_team_news(players, gameweeks)

    print(f'ok: {len(players)} players, {len(teams)} teams, '
          f'{len(gws)} gameweeks with stats, {len(fixtures)} fixtures, '
          f'{news_rows} team-news rounds on file')


if __name__ == '__main__':
    main()

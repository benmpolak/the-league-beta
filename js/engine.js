/* The League — shared game engine.
 * Pure game law, extracted from app.js so Cloud Functions can enforce the same
 * rules the client renders. No DOM, no Firebase, no globals: everything comes
 * in through make(ctx) and explicit state arguments. Browser gets window.Engine
 * (script tag), node gets module.exports (require).
 *
 * Parity with app.js is guarded by test/engine.parity.test.js — if you change
 * a rule in one place, the parity suite is what tells you about the other. */
'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const XI_RULES = { size: 11, GK: [1, 1], DF: [3, 5], MF: [2, 5], FW: [1, 3] };
  const REGULAR_GWS = 33;
  const DEFAULT_SCORING = {
    appearance: 1,
    appearance60: 2,
    goalGK: 10, goalDF: 6, goalMF: 5, goalFW: 4,
    assist: 3,
    cleanSheet: 4,
    cleanSheetMF: 1,
    per3Saves: 1,
    penSave: 5,
    penMiss: -2,
    yellow: -1,
    red: -3,
    ownGoal: -2,
    per2Conceded: -1,
  };

  const toArr = x => Array.isArray(x) ? x : (x ? Object.values(x) : []);

  /* ctx = {
   *   players:       PLAYERS array from js/data.js
   *   gameweeks:     [{n,label,from,to,finished}] (already mapped like app.js GAMEWEEKS)
   *   lastSeasonByCode: LAST_SEASON.byCode from js/history25.js, or {}
   *   now:           () => ms   (injectable clock)
   * } */
  function make(ctx) {
    const PLAYERS = ctx.players;
    const GAMEWEEKS = ctx.gameweeks;
    const LS_BY_CODE = ctx.lastSeasonByCode || {};
    const now = ctx.now || (() => Date.now());
    const PLAYER_BY_ID = Object.fromEntries(PLAYERS.map(p => [p.id, p]));

    const lastSeasonOf = p => LS_BY_CODE[p.code];
    const FPL_WIPED = PLAYERS.reduce((t, p) => t + (p.pts || 0), 0) < 2000;
    const rating = p => p.rating || lastSeasonOf(p)?.pts || 0;

    /* ---- gameweek clock ---- */
    const gwFrom = i => GAMEWEEKS[i].from;
    function currentGwIndex() {
      const t = now();
      for (let i = 0; i < GAMEWEEKS.length; i++) if (t < new Date(GAMEWEEKS[i].to).getTime()) return i;
      return GAMEWEEKS.length - 1;
    }
    const gwIsOver = i => GAMEWEEKS[i].finished || now() > new Date(GAMEWEEKS[i].to).getTime();
    const gwHasStarted = i => now() > new Date(gwFrom(i)).getTime();
    // transfers NEVER land in a gameweek already being played (no retroactive rescoring)
    const transferGw = () => { const c = currentGwIndex(); return Math.min(c + (gwHasStarted(c) ? 1 : 0), GAMEWEEKS.length - 1); };
    const gwEvent = (state, i) => state.matchStats[`gw${GAMEWEEKS[i].n}`];
    function gwStatus(state, i) {
      const ev = gwEvent(state, i);
      const synced = !!ev && Object.keys(ev.playerStats || {}).length > 0;
      if (synced && (ev.final || gwIsOver(i))) return 'final';
      if (synced) return 'live';
      if (gwHasStarted(i)) return 'underway';
      return 'upcoming';
    }
    // round robin, circle method; first team = home, alternated per round
    function pairingsFor(state, i) {
      if (i >= REGULAR_GWS) return [];
      const o = state.draft.order.length ? state.draft.order : state.managers.map(m => m.id);
      const n = o.length;
      if (n < 2) return [];
      const r = i % (n - 1);
      const rest = o.slice(1);
      const rot = rest.slice(r).concat(rest.slice(0, r));
      const line = [o[0], ...rot];
      const pairs = [];
      for (let k = 0; k < Math.floor(n / 2); k++) pairs.push([line[k], line[n - 1 - k]]);
      return i % 2 ? pairs.map(([a, b]) => [b, a]) : pairs;
    }

    /* ---- rosters ---- */
    function squadAt(state, mid, gwIdx) {
      const ids = new Set(state.draft.picks.filter(p => p.managerId === mid).map(p => p.playerId));
      for (const t of state.transfers) {
        if (t.managerId !== mid || t.gw > gwIdx) continue;
        ids.delete(t.outId);
        ids.add(t.inId);
      }
      return [...ids].map(id => PLAYER_BY_ID[id]).filter(Boolean);
    }
    function ownedIdsAt(state, gwIdx) {
      const ids = new Set();
      for (const m of state.managers) for (const p of squadAt(state, m.id, gwIdx)) ids.add(p.id);
      return ids;
    }
    function squadShapeOk(state, squad) {
      const c = { GK: 0, DF: 0, MF: 0, FW: 0 };
      squad.forEach(p => c[p.pos]++);
      const { posMin, posMax } = state.settings;
      return ['GK', 'DF', 'MF', 'FW'].every(pos => c[pos] >= posMin[pos] && c[pos] <= posMax[pos]);
    }
    // ownership computed from an arbitrary transfers list — for in-transaction checks
    function ownedIdsGiven(state, transfers, gwIdx) {
      const ids = new Set(state.draft.picks.map(p => p.playerId));
      for (const t of transfers) if (t && t.gw <= gwIdx) { ids.delete(t.outId); ids.add(t.inId); }
      return ids;
    }
    function squadIdsGiven(state, mid, transfers, gwIdx) {
      const ids = new Set(state.draft.picks.filter(p => p.managerId === mid).map(p => p.playerId));
      for (const t of transfers) if (t && t.managerId === mid && t.gw <= gwIdx) { ids.delete(t.outId); ids.add(t.inId); }
      return ids;
    }

    /* ---- new arrivals ---- */
    const isArrival = (state, p) => !!state.draftPool?.ids && state.draftPool.ids[p.id] !== p.club;
    const arrivalLocked = isArrival;

    /* ---- draft ---- */
    const totalPicks = state => state.managers.length * state.settings.squadSize;
    const pickNo = state => state.draft.picks.length;
    function currentManagerId(state) {
      const n = pickNo(state), m = state.managers.length;
      if (n >= totalPicks(state)) return null;
      const round = Math.floor(n / m), idx = n % m;
      const order = state.draft.order;
      return (round % 2 === 0) ? order[idx] : order[m - 1 - idx];
    }
    function canPick(state, mid, player) {
      if (arrivalLocked(state, player)) return false;
      const { squadSize, posMin, posMax } = state.settings;
      const squad = squadAt(state, mid, currentGwIndex());
      const c = { GK: 0, DF: 0, MF: 0, FW: 0 };
      squad.forEach(p => c[p.pos]++);
      const size = squad.length;
      if (size >= squadSize || c[player.pos] >= posMax[player.pos]) return false;
      let need = 0;
      for (const pos of ['GK', 'DF', 'MF', 'FW']) need += Math.max(0, posMin[pos] - c[pos] - (pos === player.pos ? 1 : 0));
      return need <= squadSize - size - 1;
    }
    // deterministic autopick: manager's own list first, then best available by
    // rating with id as tie-break (the server must never flip a coin)
    function autoPickChoice(state, mid) {
      const taken = new Set(state.draft.picks.map(p => p.playerId));
      let best = toArr(state.autolists?.[mid]).map(id => PLAYER_BY_ID[id])
        .find(p => p && !taken.has(p.id) && canPick(state, mid, p));
      if (!best) best = PLAYERS.filter(p => !taken.has(p.id) && canPick(state, mid, p))
        .sort((a, b) => rating(b) - rating(a) || a.id - b.id)[0];
      return best ? best.id : null;
    }

    /* ---- XI legality ---- */
    function xiCounts(pids) {
      const c = { GK: 0, DF: 0, MF: 0, FW: 0 };
      pids.forEach(id => c[PLAYER_BY_ID[id].pos]++);
      return c;
    }
    function xiValid(pids) {
      if (pids.length !== XI_RULES.size) return false;
      const c = xiCounts(pids);
      return ['GK', 'DF', 'MF', 'FW'].every(pos => c[pos] >= XI_RULES[pos][0] && c[pos] <= XI_RULES[pos][1]);
    }
    function legalizeXI(start, squad) {
      const squadIds = new Set(squad.map(p => p.id));
      const cnt = { GK: 0, DF: 0, MF: 0, FW: 0 };
      const xi = [];
      for (const id of toArr(start).filter(id => squadIds.has(id)).sort((a, b) => rating(PLAYER_BY_ID[b]) - rating(PLAYER_BY_ID[a]))) {
        const pos = PLAYER_BY_ID[id]?.pos;
        if (pos && cnt[pos] < XI_RULES[pos][1] && xi.length < XI_RULES.size && !xi.includes(id)) { xi.push(id); cnt[pos]++; }
      }
      const cands = squad.filter(p => !xi.includes(p.id)).sort((a, b) => rating(b) - rating(a));
      for (const pos of ['GK', 'DF', 'MF', 'FW']) {
        while (xi.length < XI_RULES.size && xiCounts(xi)[pos] < XI_RULES[pos][0]) {
          const c = cands.find(p => p.pos === pos && !xi.includes(p.id));
          if (!c) break;
          xi.push(c.id);
        }
      }
      for (const c of cands) {
        if (xi.length >= XI_RULES.size) break;
        if (!xi.includes(c.id) && xiCounts(xi)[c.pos] < XI_RULES[c.pos][1]) xi.push(c.id);
      }
      return xi;
    }
    const autoXI = squad => legalizeXI([], squad);
    function lineupFor(state, mid, gwIdx) {
      const squad = squadAt(state, mid, gwIdx);
      const squadIds = new Set(squad.map(p => p.id));
      const stored = state.lineups[mid] || {};
      let xi = null;
      if (stored[gwIdx]) xi = toArr(stored[gwIdx]).filter(id => squadIds.has(id));
      else {
        for (let j = gwIdx - 1; j >= 0; j--) {
          if (stored[j]) { xi = toArr(stored[j]).filter(id => squadIds.has(id)); break; }
        }
      }
      if (!xi) return autoXI(squad);
      if (xi.length === XI_RULES.size && xiValid(xi)) return xi;
      return legalizeXI(xi, squad);
    }
    function benchFor(state, mid, gwIdx) {
      const xi = new Set(lineupFor(state, mid, gwIdx));
      const squad = squadAt(state, mid, gwIdx).filter(p => !xi.has(p.id));
      const stored = state.benchOrders?.[mid] || {};
      let ord = stored[gwIdx];
      if (!ord) for (let j = gwIdx - 1; j >= 0; j--) { if (stored[j]) { ord = stored[j]; break; } }
      ord = toArr(ord);
      const byId = Object.fromEntries(squad.map(p => [p.id, p]));
      const out = ord.filter(id => byId[id]).map(id => byId[id]);
      for (const p of [...squad].sort((a, b) => rating(b) - rating(a))) if (!out.includes(p)) out.push(p);
      return out;
    }

    /* ---- scoring kernel ---- */
    function statPoints(scoring, player, s) {
      // double gameweek: score per fixture and sum
      if (s && s.fx && s.fx.length > 1) return s.fx.reduce((t, f) => t + statPoints(scoring, player, f), 0);
      const sc = scoring;
      const goalPts = { GK: sc.goalGK, DF: sc.goalDF, MF: sc.goalMF, FW: sc.goalFW }[player.pos] ?? sc.goalFW;
      const min = s.min ?? ((s.st || s.sub) ? 90 : 0);
      let pts = 0;
      if (min > 0) pts += min >= 60 ? sc.appearance60 : sc.appearance;
      pts += (s.g || 0) * goalPts + (s.a || 0) * sc.assist;
      pts += (s.og || 0) * sc.ownGoal + (s.pm || 0) * sc.penMiss;
      pts += (s.yc || 0) * sc.yellow + (s.rc || 0) * sc.red;
      const cs60 = min >= 60 ? (s.cs || 0) : 0;
      if (player.pos === 'GK' || player.pos === 'DF') {
        pts += cs60 * sc.cleanSheet;
        pts += Math.floor((s.gc || 0) / 2) * sc.per2Conceded;
      }
      if (player.pos === 'MF') pts += cs60 * sc.cleanSheetMF;
      if (player.pos === 'GK') pts += Math.floor((s.sv || 0) / 3) * sc.per3Saves + (s.ps || 0) * sc.penSave;
      return pts;
    }
    function gwPlayerPoints(state, pid, gwIdx) {
      const s = gwEvent(state, gwIdx)?.playerStats?.[pid];
      return s ? statPoints(state.settings.scoring, PLAYER_BY_ID[pid], s) : 0;
    }
    function appearedInGw(state, pid, gwIdx) {
      const s = gwEvent(state, gwIdx)?.playerStats?.[pid];
      return !!(s && (s.min || s.st || s.sub));
    }
    function effectiveXI(state, mid, gwIdx) {
      const xi = [...lineupFor(state, mid, gwIdx)];
      const ev = gwEvent(state, gwIdx);
      const anySynced = !!ev && Object.keys(ev.playerStats || {}).length > 0;
      if (!anySynced) return { xi, subs: [] };
      const bench = benchFor(state, mid, gwIdx).filter(p => appearedInGw(state, p.id, gwIdx));
      const subs = [];
      for (const pid of [...xi]) {
        if (appearedInGw(state, pid, gwIdx)) continue;
        const idx = xi.indexOf(pid);
        for (const cand of bench) {
          if (xi.includes(cand.id)) continue;
          const trial = [...xi];
          trial[idx] = cand.id;
          const c = xiCounts(trial);
          const shapeOk = ['GK', 'DF', 'MF', 'FW'].every(pos => c[pos] >= XI_RULES[pos][0] && c[pos] <= XI_RULES[pos][1]);
          if (shapeOk) {
            xi[idx] = cand.id;
            subs.push({ out: pid, in: cand.id });
            break;
          }
        }
      }
      return { xi, subs };
    }
    function gwManagerPoints(state, mid, gwIdx) {
      const xi = effectiveXI(state, mid, gwIdx).xi;
      let pts = xi.reduce((t, pid) => t + gwPlayerPoints(state, pid, gwIdx), 0);
      const bonus = +state.settings.lobusBonus || 0;
      if (bonus) {
        const lob = state.lobus?.[mid];
        const s = lob && xi.includes(lob) ? gwEvent(state, gwIdx)?.playerStats?.[lob] : null;
        if (s && (s.g || 0) + (s.a || 0) > 0) pts += bonus;
      }
      return pts;
    }
    function standingsBefore(state, gwIdx) {
      const rows = state.managers.map(m => ({ id: m.id, h2h: 0, pts: 0 }));
      const byId = Object.fromEntries(rows.map(r => [r.id, r]));
      let anyFinal = false;
      for (let i = 0; i < Math.min(gwIdx, REGULAR_GWS); i++) {
        if (gwStatus(state, i) !== 'final') continue;
        anyFinal = true;
        for (const r of rows) r.pts += gwManagerPoints(state, r.id, i);
        for (const [a, b] of pairingsFor(state, i)) {
          const pa = gwManagerPoints(state, a, i), pb = gwManagerPoints(state, b, i);
          if (pa > pb) byId[a].h2h += 3;
          else if (pb > pa) byId[b].h2h += 3;
          else { byId[a].h2h++; byId[b].h2h++; }
        }
      }
      rows.sort((x, y) => y.h2h - x.h2h || y.pts - x.pts || x.id - y.id);
      return { rows, anyFinal };
    }

    /* ---- waivers ---- */
    function nextWaiverRun(afterTs) {
      const d = new Date(afterTs);
      for (let k = 0; k < 9; k++) {
        const c = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + k, 10, 0, 0));
        if (c.getTime() > d.getTime() && [2, 5].includes(c.getUTCDay())) return c;
      }
      return new Date(d.getTime() + 3 * 864e5);
    }
    const waiverControl = state => state.waiverMeta?.control || 'auto';
    const lastWaiverRun = state => state.waiverMeta?.lastRun ? new Date(state.waiverMeta.lastRun).getTime() : 0;
    function waiverRunDue(state) {
      if (state.phase !== 'season' || waiverControl(state) !== 'auto') return false;
      const anchor = lastWaiverRun(state) || new Date(gwFrom(0)).getTime();
      return now() > nextWaiverRun(anchor).getTime();
    }
    function waiverOrder(state, gwIdx) {
      const { rows, anyFinal } = standingsBefore(state, gwIdx);
      const base = anyFinal ? rows.map(r => r.id) : [...state.draft.order];
      return [...base].reverse();
    }
    /* Pure waiver resolution. state.claims here is the MERGED view
     * {gwIndex:{mid:[{in,out}]}} (the server assembles it from the private
     * per-uid nodes). Mutates nothing; returns everything the caller must
     * apply atomically:
     *   records        — transfer records to append (n filled in-txn)
     *   executed       — [{mid,in,out}] for the toast/minutes
     *   buckets        — claim bucket indexes to clear
     *   stampedMeta    — waiverMeta with lastRun set to runStart
     *   strippedLineups— {mid: newXiArray} lineups with the out-player removed */
    function resolveWaivers(state, runStart) {
      const cur = currentGwIndex();
      const tgw = transferGw();
      const work = {
        ...state,
        transfers: [...state.transfers],
        lineups: JSON.parse(JSON.stringify(state.lineups || {})),
      };
      const buckets = Object.keys(state.claims || {}).map(Number).filter(g => g <= cur).sort((a, b) => a - b);
      const queue = waiverOrder(state, cur);
      const pending = {};
      for (const mid of queue) { pending[mid] = []; for (const g of buckets) pending[mid].push(...toArr(state.claims[g]?.[mid])); }
      const executed = [];
      const records = [];
      const strippedLineups = {};
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (let qi = 0; qi < queue.length; qi++) {
          const mid = queue[qi];
          while (pending[mid].length) {
            const c = pending[mid].shift();
            const inP = PLAYER_BY_ID[c.in];
            if (!inP || ownedIdsAt(work, tgw).has(c.in)) continue;
            if (!squadAt(work, mid, tgw).some(x => x.id === c.out)) continue;
            if (!squadShapeOk(work, [...squadAt(work, mid, tgw).filter(x => x.id !== c.out), inP])) continue;
            const rec = { managerId: mid, outId: c.out, inId: c.in, gw: tgw, t: runStart, waiver: true };
            work.transfers.push(rec);
            records.push(rec);
            const lu = work.lineups[mid]?.[tgw];
            if (lu) {
              work.lineups[mid][tgw] = toArr(lu).filter(id => id !== c.out);
              strippedLineups[mid] = work.lineups[mid][tgw];
            }
            executed.push({ mid, in: c.in, out: c.out });
            queue.splice(qi, 1); queue.push(mid);
            progressed = true;
            break;
          }
          if (progressed) break;
        }
      }
      const stampedMeta = { ...state.waiverMeta, lastRun: new Date(runStart).toISOString() };
      return { records, executed, buckets, stampedMeta, strippedLineups, tgw };
    }

    /* ---- window draft ---- */
    function wdActor(state) {
      const wd = state.windowDraft, ord = toArr(wd.order);
      const lap = Math.floor(wd.turn / ord.length), i = wd.turn % ord.length;
      return lap % 2 === 0 ? ord[i] : ord[ord.length - 1 - i];
    }

    return {
      XI_RULES, REGULAR_GWS, DEFAULT_SCORING, FPL_WIPED,
      toArr, rating, lastSeasonOf,
      currentGwIndex, gwIsOver, gwHasStarted, transferGw, gwEvent, gwStatus, gwFrom, pairingsFor,
      squadAt, ownedIdsAt, squadShapeOk, ownedIdsGiven, squadIdsGiven,
      isArrival, arrivalLocked,
      totalPicks, pickNo, currentManagerId, canPick, autoPickChoice,
      xiCounts, xiValid, legalizeXI, autoXI, lineupFor, benchFor,
      statPoints, gwPlayerPoints, appearedInGw, effectiveXI, gwManagerPoints, standingsBefore,
      nextWaiverRun, waiverControl, lastWaiverRun, waiverRunDue, waiverOrder, resolveWaivers,
      wdActor,
    };
  }

  return { make, XI_RULES, REGULAR_GWS, DEFAULT_SCORING };
});

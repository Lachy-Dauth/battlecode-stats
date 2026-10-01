// Per-map Elo.
//
// A team's official Elo says how strong it is overall. Its map Elo is that
// rating plus an offset for how it does on that map compared with its others:
//
//   P(i beats j on map m) = 1 / (1 + 10^(−(Rᵢ + μᵢ + ηᵢₘ − Rⱼ − ηⱼₘ) / D))
//
// R is each team's official rating when the game was played, taken from the
// battle log. μᵢ absorbs how far the team ran ahead of or behind its rating
// over the window (a new bot still climbing, say), so that doesn't leak into
// the maps. ηᵢₘ is the map offset, shrunk towards 0 by a N(0, τ²) prior so a
// handful of games can't produce a wild number. Each team is fitted with its
// opponents' map offsets held fixed, a few rounds over. The site shows
// current Elo + ηᵢₘ.
//
// τ was picked with scripts/check-map-elo.mjs: on two 12-hour holdouts of
// ranked games (1 Oct), anything from 60 to 120 did about equally well, far
// better than no prior at all. Counting the opponent's offset helped a little
// on one and made no difference on the other.
//
// Only ranked and tournament games count: unranked challenges can use any
// submission on either side, not the team's active bot.
import { B, G, GK } from './rows.mjs';

export const D = 400;
const C = Math.LN10 / D;
export const TAU = 80;          // prior SD of a map offset, in Elo
export const JOINT = true;      // include the opponent's map offset
const SIGMA_MU = 300;           // weak prior on the window's over/under-performance
export const WINDOWS = [
  { key: '1d', label: 'Last 24 hours', seconds: 86400 },
  { key: '3d', label: 'Last 3 days', seconds: 3 * 86400 },
  { key: '7d', label: 'Last 7 days', seconds: 7 * 86400 },
];
export const DEFAULT_WINDOW = '3d';
const MIN_MAP_SHARE = 0.01;     // maps with fewer of the counted games are tests or retired
const CHECK_HOURS = 12;         // held out to test the fit

export const counts = (row) => (row[G.kind] & (GK.ranked | GK.tournament)) !== 0;
const score = (row) => (row[G.win] === 1 ? 1 : row[G.win] === 2 ? 0 : 0.5);

/** The rating in force at time t: last post-battle Elo at or before t, else the first pre-battle Elo. */
function ratingAt(tl, t) {
  if (!tl) return null;
  let lo = 0, hi = tl.at.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tl.at[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans >= 0 ? tl.post[ans] : tl.firstPre;
}

/**
 * Each counted game's ratings at the time: [[gameRow, ra, rb]].
 *
 * A battle's id is the id of its first game, so a ranked game links to the
 * ranked battle between the same two teams with the largest id not above its
 * own, and takes that battle's pre-battle Elo. Two cases need care. While
 * ratings were frozen for the Sprint (1 Oct), ranked battles were listed at
 * 1500 v 1500 with no change; those fall back to each team's last real
 * rating. A team's first battle after the freeze lists 1500 before and the
 * restored rating after, so it uses the after. Tournament games and anything
 * that doesn't link use the rating timeline.
 */
export function gameRatings(games, battles, since = -Infinity) {
  const frozen = (r) => r[B.aElo] === 1500 && r[B.bElo] === 1500 && !r[B.dA] && !r[B.dB];
  const ranked = [...battles.values()].filter((r) => r[B.ranked] && r[B.a] != null && r[B.b] != null)
    .sort((x, y) => x[B.at] - y[B.at] || x[B.id] - y[B.id]);
  const tl = new Map();          // team -> { at: [], post: [], firstPre }
  const lastFrozen = new Map();  // team -> was its previous ranked battle a frozen one
  const afterFreeze = new Set(); // `${battleId}:${team}` whose listed pre-battle Elo is unreliable
  const byPair = new Map();      // 'a:b' -> ranked battles, by id
  for (const r of ranked) {
    const fz = frozen(r);
    for (const [id, pre, d] of [[r[B.a], r[B.aElo], r[B.dA]], [r[B.b], r[B.bElo], r[B.dB]]]) {
      if (!fz && lastFrozen.get(id)) afterFreeze.add(`${r[B.id]}:${id}`);
      lastFrozen.set(id, fz);
      if (fz || pre == null) continue;
      if (!tl.has(id)) tl.set(id, { at: [], post: [], firstPre: pre });
      const x = tl.get(id);
      x.at.push(r[B.at]);
      x.post.push(pre + (d || 0));
    }
    const k = `${r[B.a]}:${r[B.b]}`;
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(r);
  }
  for (const list of byPair.values()) list.sort((x, y) => x[B.id] - y[B.id]);

  const findBattle = (g) => {
    const list = byPair.get(`${g[G.a]}:${g[G.b]}`);
    if (!list) return null;
    let lo = 0, hi = list.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid][B.id] <= g[G.id]) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const r = list[ans];
    return r && g[G.id] < r[B.id] + Math.max(r[B.n], 1) ? r : null;
  };

  const out = [];
  let linked = 0, rankedGames = 0, missing = 0;
  for (const g of games.values()) {
    if (g[G.at] < since || !counts(g) || g[G.a] == null || g[G.b] == null || g[G.map] == null) continue;
    let ra = null, rb = null;
    if (g[G.kind] & GK.ranked) {
      rankedGames++;
      const r = findBattle(g);
      if (r && !frozen(r)) {
        linked++;
        ra = afterFreeze.has(`${r[B.id]}:${r[B.a]}`) ? r[B.aElo] + r[B.dA] : r[B.aElo];
        rb = afterFreeze.has(`${r[B.id]}:${r[B.b]}`) ? r[B.bElo] + r[B.dB] : r[B.bElo];
      }
    }
    ra ??= ratingAt(tl.get(g[G.a]), g[G.at]);
    rb ??= ratingAt(tl.get(g[G.b]), g[G.at]);
    if (ra == null || rb == null) { missing++; continue; }
    out.push([g, ra, rb]);
  }
  out.sort((x, y) => x[0][G.at] - y[0][G.at]);
  return { rated: out, linked, rankedGames, missing };
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * Fit μ and the η's for every team from rated games with from <= at < to.
 * With `joint`, the opponent's own map offset is part of the expectation
 * (a few outer rounds); otherwise opponents sit at their official rating.
 * Returns Map team -> { mu, maps: Map mapId -> { eta, se, w, d, l } }.
 */
export function fit(rated, { from = -Infinity, to = Infinity, tau = TAU, joint = JOINT } = {}) {
  // team -> mapId -> { gap: [], s: [], opp: [] }
  const byTeam = new Map();
  const add = (team, map, gap, s, opp) => {
    if (!byTeam.has(team)) byTeam.set(team, new Map());
    const m = byTeam.get(team);
    if (!m.has(map)) m.set(map, { gap: [], s: [], opp: [] });
    const c = m.get(map);
    c.gap.push(gap); c.s.push(s); c.opp.push(opp);
  };
  for (const [g, ra, rb] of rated) {
    const at = g[G.at];
    if (at < from || at >= to) continue;
    const s = score(g);
    add(g[G.a], g[G.map], ra - rb, s, g[G.b]);
    add(g[G.b], g[G.map], rb - ra, 1 - s, g[G.a]);
  }
  const res = new Map();
  const etaOf = (team, map) => res.get(team)?.maps.get(map)?.eta ?? 0;
  const rounds = joint ? 4 : 1;
  for (let round = 0; round < rounds; round++) {
    const next = new Map();
    for (const [team, cells] of byTeam) {
      const prev = res.get(team);
      let mu = prev?.mu ?? 0;
      const eta = new Map([...cells.keys()].map((m) => [m, prev?.maps.get(m)?.eta ?? 0]));
      // The opponent's offset on this map, held fixed within a round.
      const oppEta = joint ? new Map([...cells].map(([m, c]) => [m, c.opp.map((o) => etaOf(o, m))])) : null;
      const pass = (target) => {
        // One Newton step for μ (target null) or for η of one map.
        let g = 0, h = 0;
        const list = target == null ? [...cells] : [[target, cells.get(target)]];
        for (const [m, c] of list) {
          const off = mu + eta.get(m);
          const oe = oppEta?.get(m);
          for (let k = 0; k < c.gap.length; k++) {
            const p = sigmoid(C * (c.gap[k] + off - (oe ? oe[k] : 0)));
            g += C * (c.s[k] - p);
            h += C * C * p * (1 - p);
          }
        }
        return [g, h];
      };
      for (let it = 0; it < 40; it++) {
        let [g, h] = pass(null);
        g -= mu / SIGMA_MU ** 2; h += 1 / SIGMA_MU ** 2;
        let change = Math.abs(g / h);
        mu += g / h;
        for (const m of cells.keys()) {
          [g, h] = pass(m);
          const e = eta.get(m);
          g -= e / tau ** 2; h += 1 / tau ** 2;
          eta.set(m, e + g / h);
          change = Math.max(change, Math.abs(g / h));
        }
        if (change < 0.05) break;
      }
      const maps = new Map();
      for (const [m, c] of cells) {
        const [, h] = pass(m);
        let w = 0, d = 0, l = 0;
        for (const s of c.s) { if (s === 1) w++; else if (s === 0) l++; else d++; }
        maps.set(m, { eta: eta.get(m), se: 1 / Math.sqrt(h + 1 / tau ** 2), w, d, l });
      }
      next.set(team, { mu, maps });
    }
    for (const [k, v] of next) res.set(k, v);
  }
  return res;
}

/** P(A wins) for a rated game under a fit (both teams' map offsets), or the plain Elo expectation. */
export function predict(fitRes, g, ra, rb) {
  const ea = fitRes?.get(g[G.a])?.maps.get(g[G.map])?.eta ?? 0;
  const eb = fitRes?.get(g[G.b])?.maps.get(g[G.map])?.eta ?? 0;
  return sigmoid(C * (ra + ea - rb - eb));
}

/**
 * Out-of-sample check: fit on the default window before the last CHECK_HOURS,
 * then score that window's decided ranked games by log-loss, with and without
 * map offsets.
 */
export function holdoutCheck(rated, { hours = CHECK_HOURS, windowKey = DEFAULT_WINDOW, tau = TAU, joint = JOINT } = {}) {
  if (!rated.length) return null;
  const w = WINDOWS.find((x) => x.key === windowKey);
  const cut = rated[rated.length - 1][0][G.at] - hours * 3600;
  const test = rated.filter(([g]) => g[G.at] >= cut && (g[G.kind] & GK.ranked) && g[G.win] !== 0);
  if (!test.length) return null;
  const f = fit(rated, { from: cut - w.seconds, to: cut, tau, joint });
  let base = 0, model = 0, baseRight = 0, modelRight = 0;
  for (const [g, ra, rb] of test) {
    const y = g[G.win] === 1;
    const p0 = Math.min(Math.max(predict(null, g, ra, rb), 1e-9), 1 - 1e-9);
    const p1 = Math.min(Math.max(predict(f, g, ra, rb), 1e-9), 1 - 1e-9);
    base -= Math.log(y ? p0 : 1 - p0);
    model -= Math.log(y ? p1 : 1 - p1);
    if ((p0 > 0.5) === y) baseRight++;
    if ((p1 > 0.5) === y) modelRight++;
  }
  const n = test.length;
  return { hours, window: w.label.replace(/^Last /, '').toLowerCase(), games: n,
    base: base / n, model: model / n, baseAcc: baseRight / n, modelAcc: modelRight / n };
}

/** Everything the site's Maps view needs, for each window. */
export function mapElo({ games, battles, gcur, now }) {
  const longest = WINDOWS[WINDOWS.length - 1];
  const { rated, linked, rankedGames, missing } = gameRatings(games, battles, now - longest.seconds);
  const names = new Map((gcur.maps || []).map((m) => [m.id, m.name]));
  const perMap = new Map(); // mapId -> { games per window, last }
  let inLongest = 0;
  for (const [g] of rated) {
    const age = now - g[G.at];
    if (age >= longest.seconds) continue;
    inLongest++;
    if (!perMap.has(g[G.map])) perMap.set(g[G.map], { games: WINDOWS.map(() => 0), last: 0 });
    const x = perMap.get(g[G.map]);
    WINDOWS.forEach((w, i) => { if (age < w.seconds) x.games[i]++; });
    x.last = Math.max(x.last, g[G.at]);
  }
  // Maps played in the last day first, then retired ones; alphabetical within each,
  // so the columns don't shuffle from one update to the next.
  const maps = [...perMap].filter(([, x]) => x.games[WINDOWS.length - 1] >= MIN_MAP_SHARE * inLongest)
    .map(([id, x]) => ({ id, name: names.get(id) ?? `Map ${id}`, games: x.games, last: x.last }))
    .sort((a, b) => (b.games[0] > 0) - (a.games[0] > 0) || a.name.localeCompare(b.name));
  const mapIdx = new Map(maps.map((m, i) => [m.id, i]));

  // Until the game log is a week old, the longer windows start where it starts.
  const earliest = rated.length ? rated[0][0][G.at] : now;
  const teams = {};
  const windows = WINDOWS.map((w, wi) => {
    const res = fit(rated, { from: now - w.seconds, to: Infinity });
    const out = {};
    for (const [team, { mu, maps: cells }] of res) {
      const row = maps.map(() => null);
      for (const [m, c] of cells) {
        const i = mapIdx.get(m);
        if (i == null) continue;
        row[i] = [Math.round(c.eta), Math.round(c.se), c.w, c.d, c.l];
      }
      if (row.some(Boolean)) out[team] = { mu: Math.round(mu), cells: row };
    }
    teams[w.key] = out;
    return { key: w.key, label: w.label, from: Math.max(now - w.seconds, earliest), partial: earliest > now - w.seconds + 3600,
      games: maps.reduce((s, m) => s + m.games[wi], 0) };
  });
  const check = holdoutCheck(rated);
  return {
    meta: { D, tau: TAU, rankedGames, linked, unrated: missing, check },
    payload: { updatedAt: now, D, tau: TAU, defaultWindow: DEFAULT_WINDOW, windows, maps, teams, check },
  };
}

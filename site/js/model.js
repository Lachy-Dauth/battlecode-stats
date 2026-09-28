// Elo arithmetic, series probabilities and bracket simulation.
// Shared by the page and the simulation worker, so no DOM here.

export const TIERS = [
  { name: 'Fishing Boat', min: 2800 }, { name: 'Leviathan', min: 2500 }, { name: 'Orca', min: 2200 },
  { name: 'Shark', min: 1900 }, { name: 'Swordfish', min: 1600 }, { name: 'Tunafish', min: 1300 },
  { name: 'Shrimp', min: 1000 }, { name: 'Plankton', min: -Infinity },
];
export const tierOf = (elo) => TIERS.find((t) => elo >= t.min).name;

/** Expected share of games for A (also the per-game win probability, ignoring draws). */
export const expected = (ra, rb, D = 400) => 1 / (1 + 10 ** ((rb - ra) / D));

/** Site rule: a submission's K falls evenly from 96 (0 ranked battles) to 24 (10+). */
export const kForCount = (n) => (n >= 10 ? 24 : 96 - 7.2 * n);

/** round() that treats +x.5 and -x.5 symmetrically (the site doesn't document its tie rule). */
export const roundSym = (x) => Math.sign(x) * Math.round(Math.abs(x));

/** Rating change for a ranked battle: K × (share − expected), rounded. */
export const eloDelta = (share, exp, K) => roundSym(K * (share - exp));

export function choose(n, k) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** P(A wins exactly k of n games) when every game is played (ranked battles: n = 5). */
export function fixedSeries(p, n = 5) {
  return Array.from({ length: n + 1 }, (_, k) => choose(n, k) * p ** k * (1 - p) ** (n - k));
}

/** P(A is first to `need` wins): best-of-(2·need−1) knockout series. */
export function firstTo(p, need) {
  const q = 1 - p;
  let s = 0;
  for (let j = 0; j < need; j++) s += choose(need - 1 + j, j) * q ** j;
  return p ** need * s;
}

// Fast closed forms used inside the simulation loop.
const ft3 = (p) => { const q = 1 - p; return p * p * p * (1 + 3 * q + 6 * q * q); };
const ft4 = (p) => { const q = 1 - p; return p * p * p * p * (1 + 4 * q + 10 * q * q + 20 * q * q * q); };
export const seriesFn = (bestOf) => (bestOf === 7 ? ft4 : bestOf === 5 ? ft3 : (p) => firstTo(p, Math.ceil(bestOf / 2)));

/** Standard bracket order: seeds for each slot of a 2^k bracket (1 v n, n/2 v n/2+1, ...). */
export function standardOrder(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

/** Build first-round slots (team ids or null for byes) from teams ordered by seed. */
export function seededSlots(teamIdsBySeed) {
  let size = 1;
  while (size < teamIdsBySeed.length) size *= 2;
  return standardOrder(size).map((seed) => teamIdsBySeed[seed - 1] ?? null);
}

/** Gaussian sample (Box–Muller). */
function gauss(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Small fast seeded PRNG so a run is reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Monte Carlo over the season's knockouts.
 *
 * cfg = {
 *   sims, D, sigma, seed,
 *   elo: {teamId: rating},               // ratings to use (with any what-ifs applied)
 *   sprint:    { slots, bestOf, forced }, // slots: first-round team ids (null = bye)
 *   qualifier: { slots, bestOf, forced, seedOf: {teamId: seed} },
 *   grandFinal:{ bestOf, size },
 * }
 * forced[r][m] = team id known to have won match m of round r (live/finished events).
 *
 * Returns per-team counts: sprint[id] = wins-by-round array, qual[id] = {...}.
 */
export function simulate(cfg) {
  const rand = mulberry32(cfg.seed ?? 12345);
  const D = cfg.D ?? 400;
  const sigma = cfg.sigma ?? 0;
  const ids = Object.keys(cfg.elo).map(Number);
  const index = new Map(ids.map((id, i) => [id, i]));
  const base = Float64Array.from(ids, (id) => cfg.elo[id]);
  const strength = new Float64Array(ids.length);
  const caches = new Map(); // series fn -> Map(pair -> P(series win))

  const sprint = cfg.sprint ? prepBracket(cfg.sprint) : null;
  const qual = cfg.qualifier ? prepBracket(cfg.qualifier) : null;
  const gf = cfg.grandFinal ?? { bestOf: 5, size: 10 };
  const gfSeries = seriesFn(gf.bestOf);
  const gfOrder = standardOrder(16);

  const sprintRounds = sprint ? sprint.rounds : 0;
  const sprintReach = new Map(); // id -> Int32Array(rounds+1): reached round r (0 = entered)
  const qualOut = new Map();     // id -> Int32Array(6): [qfDirect, loserQual, qualified, gfFinal, gfWin, qualWin]
  const bump = (map, id, len, i) => {
    let a = map.get(id);
    if (!a) { a = new Int32Array(len); map.set(id, a); }
    a[i]++;
  };

  function prob(a, b, series) {
    const sa = strength[index.get(a)], sb = strength[index.get(b)];
    if (sigma === 0) {
      let cache = caches.get(series);
      if (!cache) caches.set(series, (cache = new Map()));
      const key = a * 100003 + b;
      let v = cache.get(key);
      if (v === undefined) { v = series(1 / (1 + 10 ** ((sb - sa) / D))); cache.set(key, v); }
      return v;
    }
    return series(1 / (1 + 10 ** ((sb - sa) / D)));
  }

  // Plays a knockout from `slots`; calls onRound(r, winners, losers) after each round.
  function play(br, onRound) {
    let cur = br.slots;
    for (let r = 0; r < br.rounds; r++) {
      const next = new Array(cur.length / 2);
      const losers = [];
      for (let m = 0; m < next.length; m++) {
        const a = cur[2 * m], b = cur[2 * m + 1];
        let w;
        const forced = br.forced?.[r]?.[m];
        if (a == null || b == null) w = a ?? b;
        else if (forced != null && (forced === a || forced === b)) w = forced;
        else w = rand() < prob(a, b, br.series) ? a : b;
        next[m] = w ?? null;
        if (a != null && b != null) losers.push({ id: w === a ? b : a, m });
      }
      onRound(r, next, losers);
      cur = next;
    }
    return cur[0];
  }

  for (let s = 0; s < cfg.sims; s++) {
    for (let i = 0; i < ids.length; i++) strength[i] = sigma ? base[i] + sigma * gauss(rand) : base[i];

    if (sprint) {
      for (const id of sprint.entrants) bump(sprintReach, id, sprintRounds + 1, 0);
      play(sprint, (r, winners) => { for (const w of winners) if (w != null) bump(sprintReach, w, sprintRounds + 1, r + 1); });
    }

    if (qual) {
      const r16 = qual.rounds - 4; // round whose 8 matches have 16 teams
      let r16Losers = [];
      const qfTeams = [];
      const qualWinner = play(qual, (r, winners, losers) => {
        if (r === r16) { qfTeams.push(...winners.filter((w) => w != null)); r16Losers = losers.map((l) => l.id); }
      });
      if (qualWinner != null) bump(qualOut, qualWinner, 6, 5);
      // Loser bracket: R16 losers reseeded by original seed, 1v8 4v5 2v7 3v6; the two semi winners qualify.
      const L = r16Losers.sort((a, b) => qual.seedOf[a] - qual.seedOf[b]);
      const lr = [];
      for (const [x, y] of [[0, 7], [3, 4], [1, 6], [2, 5]]) {
        const a = L[x], b = L[y];
        lr.push(a == null || b == null ? a ?? b : rand() < prob(a, b, qual.series) ? a : b);
      }
      const lq = [];
      for (const [x, y] of [[0, 1], [2, 3]]) {
        const a = lr[x], b = lr[y];
        lq.push(a == null || b == null ? a ?? b : rand() < prob(a, b, qual.series) ? a : b);
      }
      for (const id of qfTeams) { bump(qualOut, id, 6, 0); bump(qualOut, id, 6, 2); }
      for (const id of lq) if (id != null) { bump(qualOut, id, 6, 1); bump(qualOut, id, 6, 2); }

      // Grand Final (assumed format): the qualifiers seeded by rating into a
      // 16-slot single-elimination bracket, so the top six get byes.
      const field = [...qfTeams, ...lq.filter((x) => x != null)]
        .sort((a, b) => base[index.get(b)] - base[index.get(a)]);
      let cur = gfOrder.map((seed) => field[seed - 1] ?? null);
      while (cur.length > 1) {
        const next = [];
        for (let m = 0; m < cur.length; m += 2) {
          const a = cur[m], b = cur[m + 1];
          next.push(a == null || b == null ? a ?? b : rand() < prob(a, b, gfSeries) ? a : b);
          if (cur.length === 2) for (const f of [a, b]) if (f != null) bump(qualOut, f, 6, 3);
        }
        cur = next;
      }
      if (cur[0] != null) bump(qualOut, cur[0], 6, 4);
    }
  }

  const toObj = (map) => Object.fromEntries([...map.entries()].map(([k, v]) => [k, Array.from(v)]));
  return { sims: cfg.sims, sprintRounds, sprint: toObj(sprintReach), qual: toObj(qualOut) };

  function prepBracket(b) {
    let rounds = 0;
    while (2 ** rounds < b.slots.length) rounds++;
    return {
      slots: b.slots, rounds, forced: b.forced, seedOf: b.seedOf || {},
      series: seriesFn(b.bestOf ?? 7), entrants: b.slots.filter((x) => x != null),
    };
  }
}

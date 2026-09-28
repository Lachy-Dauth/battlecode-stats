#!/usr/bin/env node
// Scrape game.battlecode.au into static JSON for the stats site.
//
//   node scraper/scrape.mjs --state <dir> --out <dir>
//
// <state> keeps what accumulates between runs (every battle seen, sampled
// match details, cached team pages). <out> is what the site reads.
// The first run backfills the whole battle history; later runs are incremental.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pageData, mapLimit, stats, toSec } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const STATE = path.resolve(args.state || '.cache/state');
const OUT = path.resolve(args.out || 'site/data');
const env = (k, d) => Number(process.env[k] ?? d);
const MAX_BATTLE_PAGES = env('MAX_BATTLE_PAGES', 1500);   // backfill ceiling (100 battles/page)
const DETAIL_CAP = env('DETAIL_CAP', 450);                // match details per incremental run
const BACKFILL_DETAIL_CAP = env('BACKFILL_DETAIL_CAP', 900);
const BACKFILL_TEAMS = env('BACKFILL_TEAMS', 100);        // teams whose submission history is backfilled
const BACKFILL_SPACING = env('BACKFILL_SPACING_H', 8) * 3600;
const TEAM_PAGE_CAP = env('TEAM_PAGE_CAP', Infinity);
const OVERLAP = 30 * 60;                                  // re-read this much before the cursor

const NOW = Math.floor(Date.now() / 1000);
const log = (...a) => console.log(`[${((Date.now() / 1000) - NOW).toFixed(0).padStart(4)}s]`, ...a);

// ---- small fs helpers ----------------------------------------------------
async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJSON(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data));
}

// Battle rows are stored compactly, one file per UTC day.
// [id, at, ranked, challenge, aId, bId, aElo, bElo, winsA, winsB, games, dA, dB, replayId]
const B = { id: 0, at: 1, ranked: 2, challenge: 3, a: 4, b: 5, aElo: 6, bElo: 7, wa: 8, wb: 9, n: 10, dA: 11, dB: 12, replay: 13 };
const DONE = new Set(['a', 'b', 'draw']);

function battleRow(x) {
  return [x.id, toSec(x.at), x.ranked ? 1 : 0, x.challenge ? 1 : 0, x.a?.id ?? null, x.b?.id ?? null,
    x.a?.elo ?? null, x.b?.elo ?? null, x.winsA, x.winsB, x.resultsA?.length ?? 0,
    x.eloChangeA ?? 0, x.eloChangeB ?? 0, x.replayId ?? x.id];
}

async function loadBattles() {
  const dir = path.join(STATE, 'battles');
  const map = new Map();
  let files = [];
  try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort(); } catch {}
  for (const f of files) for (const r of await readJSON(path.join(dir, f), [])) map.set(r[0], r);
  return map;
}
async function saveBattles(map) {
  const byDay = new Map();
  for (const r of map.values()) {
    const day = new Date(r[B.at] * 1000).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  for (const [day, rows] of byDay) {
    rows.sort((x, y) => x[B.at] - y[B.at] || x[0] - y[0]);
    await writeJSON(path.join(STATE, 'battles', `${day}.json`), rows);
  }
}

// ---- 1. leaderboard ---------------------------------------------------------
async function fetchLeaderboard() {
  const first = await pageData('/leaderboard', { list: 'leaderboard' });
  const pages = first.pages;
  const byId = new Map(first.teams.map((t) => [t.id, t]));
  const rest = await mapLimit(Array.from({ length: pages - 1 }, (_, i) => i + 2),
    (p) => pageData(`/leaderboard?page=${p}`, { list: 'leaderboard' }));
  for (const r of rest) if (r?.teams) for (const t of r.teams) byId.set(t.id, t);
  if (byId.size < first.total) {
    // Ratings moved while paging and shifted someone across a page boundary.
    for (let p = 1; p <= pages && byId.size < first.total; p++) {
      const r = await pageData(`/leaderboard?page=${p}`, { list: 'leaderboard' });
      for (const t of r.teams) if (!byId.has(t.id)) byId.set(t.id, t);
    }
  }
  log(`leaderboard: ${byId.size}/${first.total} teams over ${pages} pages`);
  return [...byId.values()];
}

// ---- 2. tournaments -----------------------------------------------------------
async function fetchTournaments() {
  const list = await pageData('/tournaments');
  const out = [];
  for (const t of list.tournaments) {
    try {
      const d = await pageData(`/tournaments/${t.id}`);
      out.push({ ...d.tournament, cut: d.cut ?? [] });
    } catch (err) {
      log(`tournament ${t.id}: ${err.message}`);
      out.push(t);
    }
  }
  return out;
}

// ---- 3. battles -----------------------------------------------------------------
async function fetchBattles(battles, cursor) {
  const since = cursor.lastAt ? cursor.lastAt - OVERLAP : 0;
  let maxAt = cursor.lastAt || 0, added = 0, pagesRead = 0, newlyDone = [];
  const take = (list) => {
    for (const x of list) {
      if (!DONE.has(x.outcome)) continue;
      const row = battleRow(x);
      const had = battles.get(row[0]);
      if (!had) { added++; newlyDone.push(row); }
      battles.set(row[0], row);
      if (row[B.at] > maxAt) maxAt = row[B.at];
    }
  };
  const first = await pageData('/battles', { list: 'battles' });
  pagesRead++;
  take(first.battles);
  const totalPages = Math.ceil(first.total / first.perPage);
  const limit = Math.min(totalPages, MAX_BATTLE_PAGES);
  const oldest = (list) => Math.min(...list.map((x) => toSec(x.at)));
  if (since && oldest(first.battles) < since) {
    log(`battles: 1 page, +${added}`);
  } else if (since) {
    // Incremental: walk back until we pass the cursor.
    for (let p = 2; p <= limit; p++) {
      const d = await pageData(`/battles?page=${p}`, { list: 'battles' });
      pagesRead++;
      take(d.battles);
      if (!d.battles.length || oldest(d.battles) < since) break;
    }
  } else {
    // Backfill: everything.
    const pages = Array.from({ length: limit - 1 }, (_, i) => i + 2);
    const res = await mapLimit(pages, (p) => pageData(`/battles?page=${p}`, { list: 'battles' }),
      (n, of) => log(`battles backfill ${n}/${of} pages`));
    for (const d of res) if (d?.battles) { pagesRead++; take(d.battles); }
  }
  log(`battles: read ${pagesRead} pages, +${added} completed (stored ${battles.size})`);
  return { maxAt, newlyDone };
}

// ---- 4. team pages -------------------------------------------------------------
// Team pages are the heaviest reads, and between fetches the battle log fills
// in history and record (see writeOutputs). So a changed team is only
// re-read every few hours; the top of the ladder every run.
const TEAM_REFRESH = env('TEAM_REFRESH_H', 6) * 3600;
const TEAM_REFRESH_TOP = env('TEAM_REFRESH_TOP', 40);

async function fetchTeamPages(teams, cursor) {
  const sigs = cursor.teamSigs || {};
  if (!cursor.teamFetched) {
    cursor.teamFetched = {};
    for (const t of teams) {
      const c = await readJSON(path.join(STATE, 'teams', `${t.id}.json`), null);
      if (c?.fetchedAt) cursor.teamFetched[t.id] = c.fetchedAt;
    }
  }
  const fetched = cursor.teamFetched;
  const top = new Set(teams.filter((t) => t.ranked).sort((a, b) => b.elo - a.elo).slice(0, TEAM_REFRESH_TOP).map((t) => t.id));
  const todo = teams.filter((t) => {
    if (!t.hasBot && !t.ranked) return false;
    if (!fetched[t.id]) return true;
    if (sigs[t.id] === teamSig(t)) return false;
    return NOW - fetched[t.id] >= (top.has(t.id) ? 50 * 60 : TEAM_REFRESH);
  }).sort((a, b) => b.elo - a.elo).slice(0, TEAM_PAGE_CAP);
  log(`team pages: ${todo.length} changed`);
  const res = await mapLimit(todo, async (t) => {
    const d = await pageData(`/teams/${t.id}`);
    const cached = {
      id: t.id,
      fetchedAt: NOW,
      description: d.team?.description ?? '',
      skin: d.team?.skin ?? null,
      record: d.record ? [d.record.wins, d.record.draws, d.record.losses] : null,
      peak: d.peak ?? null,
      bestRank: d.ranks?.best ?? null,
      history: (d.history || []).map((p) => [toSec(p.date), p.elo]),
      ranks: (d.ranks?.points || []).map((p) => [toSec(p.date), p.elo]),
    };
    await writeJSON(path.join(STATE, 'teams', `${t.id}.json`), cached);
    sigs[t.id] = teamSig(t);
    fetched[t.id] = NOW;
    return true;
  }, (n, of) => log(`team pages ${n}/${of}`));
  const failed = res.filter((r) => r?.error).length;
  if (failed) log(`team pages: ${failed} failed`);
  cursor.teamSigs = sigs;
}
const teamSig = (t) => `${t.elo}|${t.ranked}|${t.hasBot}`;

// ---- 5. match details (submission ids + maps) ------------------------------------
async function fetchDetails(battles, details, newlyDone, teams, cursor) {
  const want = new Map(); // battleId -> row
  const covered = new Set();
  const addBattle = (r) => {
    if (details[r[0]] || want.has(r[0])) { covered.add(r[B.a]); covered.add(r[B.b]); return; }
    if (covered.has(r[B.a]) && covered.has(r[B.b])) return;
    want.set(r[0], r); covered.add(r[B.a]); covered.add(r[B.b]);
  };
  // Latest battle per team that played since the last run: tracks submission
  // changes. Ranked battles first: they always use the team's active bot,
  // while unranked challenges can use any of the requester's submissions.
  const newest = [...newlyDone].sort((x, y) => y[B.at] - x[B.at]);
  newest.filter((r) => r[B.ranked]).forEach(addBattle);
  newest.forEach(addBattle);
  const incremental = [...want.values()].slice(0, cursor.detailBackfill ? DETAIL_CAP : Math.max(DETAIL_CAP, 800));
  want.clear();
  for (const r of incremental) want.set(r[0], r);

  // One-time backfill: sample the top teams' history every few hours so their
  // earlier submissions show up too.
  if (!cursor.detailBackfill) {
    const byTeam = new Map();
    for (const r of battles.values()) for (const id of [r[B.a], r[B.b]]) {
      if (!byTeam.has(id)) byTeam.set(id, []);
      byTeam.get(id).push(r);
    }
    const top = teams.filter((t) => t.ranked).sort((a, b) => b.elo - a.elo).slice(0, BACKFILL_TEAMS);
    const sampled = new Map();
    const haveAt = new Map(); // team -> times already observed
    for (const [id, d] of Object.entries(details)) for (const tid of [d[3], d[4]]) {
      if (!haveAt.has(tid)) haveAt.set(tid, []);
      haveAt.get(tid).push(d[5]);
    }
    for (const t of top) {
      const rows = (byTeam.get(t.id) || []).sort((x, y) => x[B.at] - y[B.at]);
      const seen = [...(haveAt.get(t.id) || [])];
      for (const r of rows) {
        if (seen.some((s) => Math.abs(s - r[B.at]) < BACKFILL_SPACING)) continue;
        seen.push(r[B.at]);
        if (!details[r[0]] && !want.has(r[0])) sampled.set(r[0], r);
      }
      // Always have the very latest one too.
      const last = rows[rows.length - 1];
      if (last && !details[last[0]]) sampled.set(last[0], last);
    }
    [...sampled.values()].slice(0, BACKFILL_DETAIL_CAP).forEach((r) => want.set(r[0], r));
    log(`details: backfill sampled ${Math.min(sampled.size, BACKFILL_DETAIL_CAP)} battles for top ${top.length} teams`);
  }

  // One-time: ranked-only samples for the top teams, so their active-bot
  // timeline doesn't depend on unranked test battles.
  if (!cursor.rankedBackfill) {
    const top = teams.filter((t) => t.ranked).sort((a, b) => b.elo - a.elo).slice(0, env('RANKED_BACKFILL_TEAMS', 60));
    const spacing = env('RANKED_BACKFILL_SPACING_H', 12) * 3600;
    const rankedAt = new Map();
    for (const [bid, d] of Object.entries(details)) {
      const r = battles.get(Number(bid));
      if (!r?.[B.ranked]) continue;
      for (const tid of [d[3], d[4]]) { if (!rankedAt.has(tid)) rankedAt.set(tid, []); rankedAt.get(tid).push(d[5]); }
    }
    let added = 0;
    for (const t of top) {
      const seen = [...(rankedAt.get(t.id) || []), ...[...want.values()].filter((r) => r[B.ranked] && (r[B.a] === t.id || r[B.b] === t.id)).map((r) => r[B.at])];
      const rows = [...battles.values()].filter((r) => r[B.ranked] && (r[B.a] === t.id || r[B.b] === t.id)).sort((x, y) => y[B.at] - x[B.at]);
      for (const r of rows) {
        if (seen.some((x) => Math.abs(x - r[B.at]) < spacing)) continue;
        seen.push(r[B.at]);
        if (!details[r[0]] && !want.has(r[0])) { want.set(r[0], r); added++; }
      }
    }
    log(`details: ranked backfill sampled ${added} battles for top ${top.length} teams`);
  }

  const memberTeam = new Map();
  for (const t of teams) for (const m of t.members || []) if (m.id) memberTeam.set(m.id, t.id);

  const list = [...want.values()];
  log(`details: fetching ${list.length}`);
  let ok = 0;
  await mapLimit(list, async (r) => {
    const d = await pageData(`/visualiser?match=${r[B.replay]}`);
    const m = d?.battle?.match;
    if (!m) return;
    const games = (d.games || []).filter((g) => g.status === 'completed').map((g) => [g.mapName, g.winner]);
    // Which side asked for it: 'a' | 'b' | 'x' (autoscrim or unknown).
    const reqTeam = m.requestedBy ? memberTeam.get(m.requestedBy) : null;
    const req = reqTeam === m.teamAId ? 'a' : reqTeam === m.teamBId ? 'b' : 'x';
    // [subA, subB, games, aId, bId, at, requester]
    details[r[0]] = [m.submissionAId ?? null, m.submissionBId ?? null, games, m.teamAId, m.teamBId, r[B.at], req];
    ok++;
  }, (n, of) => log(`details ${n}/${of}`));
  log(`details: +${ok} (stored ${Object.keys(details).length})`);
  if (!cursor.detailBackfill) cursor.detailBackfill = NOW;
  if (!cursor.rankedBackfill) cursor.rankedBackfill = NOW;
}

// ---- 6. derived outputs -------------------------------------------------------------
const TIERS = [[2800, 'Fishing Boat'], [2500, 'Leviathan'], [2200, 'Orca'], [1900, 'Shark'],
  [1600, 'Swordfish'], [1300, 'Tunafish'], [1000, 'Shrimp'], [-Infinity, 'Plankton']];

function eloAt(history, t) {
  // history: [[t, elo]] ascending. Rating in force at time t.
  let lo = 0, hi = history.length - 1, ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid][0] <= t) { ans = history[mid][1]; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function perspective(r, teamId) {
  const isA = r[B.a] === teamId;
  const draws = Math.max(0, r[B.n] - r[B.wa] - r[B.wb]);
  const w = isA ? r[B.wa] : r[B.wb], l = isA ? r[B.wb] : r[B.wa];
  return {
    opp: isA ? r[B.b] : r[B.a],
    myElo: isA ? r[B.aElo] : r[B.bElo], oppElo: isA ? r[B.bElo] : r[B.aElo],
    w, l, d: draws, delta: isA ? r[B.dA] : r[B.dB],
    result: w > l ? 'W' : w < l ? 'L' : 'D',
  };
}

function buildSubmissions(teamId, obs, rows) {
  // obs: [[t, sub, battleId]] ascending; rows: team's battles ascending.
  const segs = [];
  for (const [t, sub] of obs) {
    const last = segs[segs.length - 1];
    if (last && last.sub === sub) { last.last = t; last.obs++; } else segs.push({ sub, first: t, last: t, obs: 1 });
  }
  const exact = new Map(obs.map(([t, sub, bid]) => [bid, sub]));
  let j = 0;
  for (const s of segs) Object.assign(s, { series: [0, 0, 0], games: [0, 0, 0], ranked: 0, eloDelta: 0 });
  for (const r of rows) {
    const t = r[B.at];
    let sub = exact.get(r[0]);
    while (j < obs.length && obs[j][0] <= t) j++;
    const prev = obs[j - 1], next = obs[j];
    // Between two sightings of the same bot, ranked battles must have used it too.
    if (sub == null && r[B.ranked] && prev && next && prev[1] === next[1]) sub = prev[1];
    if (sub == null && prev && !next && prev[0] === t) sub = prev[1];
    if (sub == null) continue;
    // The segment containing t with this sub.
    const seg = segs.find((s) => s.sub === sub && s.first <= t && t <= s.last) ||
      segs.find((s) => s.sub === sub && s.first <= t + 1 && t - 1 <= s.last);
    if (!seg) continue;
    const p = perspective(r, teamId);
    seg.series[p.result === 'W' ? 0 : p.result === 'D' ? 1 : 2]++;
    seg.games[0] += p.w; seg.games[1] += p.d; seg.games[2] += p.l;
    if (r[B.ranked]) { seg.ranked++; seg.eloDelta += p.delta; }
  }
  return segs;
}

function fitCalibration(battles, since) {
  // Per-game win probability vs Elo gap in ranked 5-game series.
  const games = [];
  for (const r of battles.values()) {
    if (!r[B.ranked] || r[B.at] < since || r[B.aElo] == null || r[B.bElo] == null) continue;
    const diff = r[B.aElo] - r[B.bElo];
    const decided = r[B.wa] + r[B.wb];
    if (!decided) continue;
    games.push([diff, r[B.wa], r[B.wb]]);
  }
  const ll = (D) => {
    let s = 0;
    for (const [diff, w, l] of games) {
      const p = 1 / (1 + 10 ** (-diff / D));
      s += w * Math.log(Math.max(p, 1e-12)) + l * Math.log(Math.max(1 - p, 1e-12));
    }
    return s;
  };
  let best = 400, bestLL = -Infinity;
  for (let D = 150; D <= 2000; D += 10) { const v = ll(D); if (v > bestLL) { bestLL = v; best = D; } }
  // Bins by absolute gap (from the favourite's side).
  const width = 25, bins = new Map();
  for (const [diff, w, l] of games) {
    const fav = diff >= 0;
    const gap = Math.abs(diff);
    const k = Math.min(Math.floor(gap / width), 15);
    if (!bins.has(k)) bins.set(k, { lo: k * width, hi: k === 15 ? null : (k + 1) * width, games: 0, favWins: 0, series: 0, gapSum: 0 });
    const b = bins.get(k);
    b.games += w + l; b.favWins += fav ? w : l; b.series++; b.gapSum += gap * (w + l);
  }
  return {
    fittedDivisor: best, series: games.length,
    games: games.reduce((s, g) => s + g[1] + g[2], 0),
    bins: [...bins.values()].sort((a, b) => a.lo - b.lo).map((b) => ({
      lo: b.lo, hi: b.hi, series: b.series, games: b.games, favWinRate: b.favWins / b.games, meanGap: b.gapSum / b.games,
    })),
  };
}

async function writeOutputs({ teams, tournaments, battles, details }) {
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const rowsByTeam = new Map();
  for (const r of battles.values()) for (const id of [r[B.a], r[B.b]]) {
    if (id == null) continue;
    if (!rowsByTeam.has(id)) rowsByTeam.set(id, []);
    rowsByTeam.get(id).push(r);
  }
  for (const rows of rowsByTeam.values()) rows.sort((x, y) => x[B.at] - y[B.at] || x[0] - y[0]);

  // Only ranked battles are guaranteed to use each team's active bot.
  // Unranked challenges can pit any submission of either team (tests, or an
  // opponent choosing an older version), so those sightings are kept apart.
  const obsByTeam = new Map();
  const testByTeam = new Map();
  const mapsByTeam = new Map();
  for (const [bid, [subA, subB, games, aId, bId, at, req]] of Object.entries(details)) {
    const row = battles.get(Number(bid));
    for (const [tid, sub, side] of [[aId, subA, 'a'], [bId, subB, 'b']]) {
      if (sub == null) continue;
      const active = !!row?.[B.ranked];
      const target = active ? obsByTeam : testByTeam;
      if (!target.has(tid)) target.set(tid, []);
      target.get(tid).push([at, sub, Number(bid)]);
      if (!mapsByTeam.has(tid)) mapsByTeam.set(tid, {});
      const m = mapsByTeam.get(tid);
      for (const [map, winner] of games) {
        m[map] ??= [0, 0, 0];
        m[map][winner === side ? 0 : winner === 'draw' || winner == null ? 1 : 2]++;
      }
    }
  }
  for (const o of obsByTeam.values()) o.sort((x, y) => x[0] - y[0]);

  const outTeams = [];
  await fs.rm(path.join(OUT, 'teams'), { recursive: true, force: true });
  for (const t of teams) {
    const cached = await readJSON(path.join(STATE, 'teams', `${t.id}.json`), null);
    const rows = rowsByTeam.get(t.id) || [];
    // History/record/ranks = last team-page fetch + whatever the battle log adds since.
    const since = cached?.fetchedAt ?? 0;
    const hist = cached?.history?.length ? cached.history.slice() : (t.history || []).map((p) => [toSec(p.date), p.elo]);
    const record = cached?.record ? cached.record.slice() : null;
    for (const r of rows) {
      if (r[B.at] <= since) continue;
      const p = perspective(r, t.id);
      if (record) { record[0] += p.w; record[1] += p.d; record[2] += p.l; }
      if (r[B.ranked] && p.myElo != null && cached?.history?.length) hist.push([r[B.at], p.myElo + p.delta]);
    }
    if (hist.length && hist[hist.length - 1][1] !== t.elo) hist.push([NOW, t.elo]);
    const ranks = (cached?.ranks || []).slice();
    if (t.ranked && ranks.length && ranks[ranks.length - 1][1] !== t.rank) ranks.push([NOW, t.rank]);
    const peak = Math.max(cached?.peak ?? -Infinity, ...hist.map((h) => h[1]));
    const bestRank = t.ranked ? Math.min(cached?.bestRank ?? Infinity, t.rank) : cached?.bestRank ?? null;
    const e24 = eloAt(hist, NOW - 86400), e7 = eloAt(hist, NOW - 7 * 86400);
    const obs = obsByTeam.get(t.id) || [];
    const subs = buildSubmissions(t.id, obs, rows);
    const activeIds = new Set(obs.map((o) => o[1]));
    const tested = new Map();
    for (const [at, sub, bid] of (testByTeam.get(t.id) || []).sort((x, y) => x[0] - y[0])) {
      if (activeIds.has(sub)) continue;
      if (!tested.has(sub)) tested.set(sub, { sub, first: at, last: at, battles: 0, games: [0, 0, 0] });
      const x = tested.get(sub);
      x.last = at; x.battles++;
      const r = battles.get(bid);
      if (r) { const p = perspective(r, t.id); x.games[0] += p.w; x.games[1] += p.d; x.games[2] += p.l; }
    }
    const recent24 = rows.filter((r) => r[B.at] >= NOW - 86400);
    const last = rows[rows.length - 1];
    const curSub = subs[subs.length - 1];
    const prevSub = [...subs].reverse().find((x) => curSub && x.sub !== curSub.sub);

    const summary = {
      id: t.id, name: t.name, rank: t.rank, ranked: !!t.ranked, elo: t.elo, gameWins: t.wins,
      hasBot: !!t.hasBot, language: t.language ?? null,
      spark: (t.history || []).map((p) => [toSec(p.date), p.elo]),
      accepting: !!t.settings?.ranked, acceptingChangedAt: toSec(t.settings?.rankedChangedAt),
      joinsClosed: !!t.settings?.joinsClosed,
      dev: !!t.dev, highSchool: !!t.highSchool, eligible: !!t.eligible, firstYear: !!t.firstYear,
      wgm: !!t.wgm, unsw: !!t.unsw, university: t.university ?? '', countries: t.countries ?? [],
      members: (t.members || []).map((m) => m.username),
      record, peak: Number.isFinite(peak) ? peak : null, bestRank: Number.isFinite(bestRank) ? bestRank : null,
      d24: e24 != null ? t.elo - e24 : null, d7: e7 != null ? t.elo - e7 : null,
      lastBattle: last ? last[B.at] : null,
      series24: recent24.length, ranked24: recent24.filter((r) => r[B.ranked]).length,
      submission: curSub ? curSub.sub : null, submissionSince: curSub ? curSub.first : null,
      submissionsSeen: new Set(subs.map((s) => s.sub)).size,
      previousSubmission: prevSub ? prevSub.sub : null,
      previousLastSeen: prevSub ? prevSub.last : null,
      // Rating when the current submission was first seen (the switch happened at or before this).
      submissionElo: curSub ? eloAt(hist, curSub.first) : null,
    };
    outTeams.push(summary);

    if (!t.hasBot && !t.ranked && !rows.length) continue;
    // Head to head
    const h2h = new Map();
    for (const r of rows) {
      const p = perspective(r, t.id);
      if (!h2h.has(p.opp)) h2h.set(p.opp, { opp: p.opp, series: [0, 0, 0], games: [0, 0, 0], ranked: 0, eloDelta: 0, last: 0 });
      const h = h2h.get(p.opp);
      h.series[p.result === 'W' ? 0 : p.result === 'D' ? 1 : 2]++;
      h.games[0] += p.w; h.games[1] += p.d; h.games[2] += p.l;
      if (r[B.ranked]) { h.ranked++; h.eloDelta += p.delta; }
      h.last = Math.max(h.last, r[B.at]);
    }
    const detail = {
      ...summary,
      description: cached?.description ?? '', skin: cached?.skin ?? null,
      members: (t.members || []).map((m) => ({ username: m.username, institution: m.institution ?? '' })),
      history: hist, ranks,
      submissions: subs,
      testedSubmissions: [...tested.values()].sort((a, b) => b.last - a.last),
      maps: Object.entries(mapsByTeam.get(t.id) || {}).map(([map, [w, d, l]]) => ({ map, w, d, l }))
        .sort((a, b) => (b.w + b.d + b.l) - (a.w + a.d + a.l)),
      h2h: [...h2h.values()].sort((a, b) => b.last - a.last),
      battles: rows.slice(-150).reverse().map((r) => ({ id: r[0], at: r[B.at], ranked: !!r[B.ranked], challenge: !!r[B.challenge],
        replay: r[B.replay], sub: details[r[0]] ? details[r[0]][r[B.a] === t.id ? 0 : 1] : undefined, ...perspective(r, t.id) })),
      battleCount: rows.length,
    };
    await writeJSON(path.join(OUT, 'teams', `${t.id}.json`), detail);
  }
  await writeJSON(path.join(OUT, 'teams.json'), outTeams);

  // Tournaments + Grand Final (the site lists it but has no bracket page for it yet).
  await writeJSON(path.join(OUT, 'tournaments.json'), {
    tournaments,
    grandFinal: {
      id: 'grand-final', name: 'Grand Final', teams: 10, bestOf: 5, date: '2026-10-17T00:00:00.000Z',
      venue: 'UNSW Sydney', prize: '$8,000 first, $18,500 across the top six', entry: 'Qualifier winners',
    },
  });

  // Recent battles feed.
  const recent = [...battles.values()].sort((x, y) => y[B.at] - x[B.at]).slice(0, 800).map((r) => ({
    id: r[0], at: r[B.at], ranked: !!r[B.ranked], challenge: !!r[B.challenge], a: r[B.a], b: r[B.b],
    aElo: r[B.aElo], bElo: r[B.bElo], wa: r[B.wa], wb: r[B.wb], n: r[B.n], dA: r[B.dA], dB: r[B.dB], replay: r[B.replay],
  }));
  await writeJSON(path.join(OUT, 'battles-recent.json'), recent);

  // Activity: series completed per hour, last 72h.
  const hours = new Map();
  for (const r of battles.values()) {
    if (r[B.at] < NOW - 72 * 3600) continue;
    const h = Math.floor(r[B.at] / 3600) * 3600;
    if (!hours.has(h)) hours.set(h, [0, 0]);
    hours.get(h)[r[B.ranked] ? 0 : 1]++;
  }
  const calibration = fitCalibration(battles, NOW - 4 * 86400);
  const tierCounts = TIERS.map(([min, name]) => ({ name, min, count: 0 }));
  for (const t of teams) if (t.ranked) tierCounts.find((x) => t.elo >= x.min).count++;

  const meta = {
    updatedAt: NOW,
    source: 'https://game.battlecode.au',
    counts: { teams: teams.length, rankedTeams: teams.filter((t) => t.ranked).length, battles: battles.size, details: Object.keys(details).length },
    battleSpan: battles.size ? [Math.min(...[...battles.values()].map((r) => r[B.at])), Math.max(...[...battles.values()].map((r) => r[B.at]))] : null,
    calibration,
    activity: [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([t, [r, u]]) => ({ t, ranked: r, unranked: u })),
    tiers: tierCounts,
    run: { ...stats, seconds: Math.round(Date.now() / 1000 - NOW) },
  };
  await writeJSON(path.join(OUT, 'meta.json'), meta);
  log(`wrote ${outTeams.length} teams, ${recent.length} recent battles; fitted Elo divisor ${calibration.fittedDivisor} over ${calibration.games} games`);
}

// ---- main ----------------------------------------------------------------------------
async function main() {
  await fs.mkdir(STATE, { recursive: true });
  const cursor = await readJSON(path.join(STATE, 'cursor.json'), {});
  const battles = await loadBattles();
  const details = await readJSON(path.join(STATE, 'details.json'), {});
  log(`state: ${battles.size} battles, ${Object.keys(details).length} details, cursor ${cursor.lastAt ? new Date(cursor.lastAt * 1000).toISOString() : 'none'}`);

  if (args['derive-only']) {
    // Rebuild the site's JSON from saved state without touching the network.
    const teams = await readJSON(path.join(STATE, 'leaderboard.json'), null);
    const tournaments = await readJSON(path.join(STATE, 'tournaments.json'), []);
    if (!teams) throw new Error('no saved leaderboard in state; run a normal scrape first');
    await writeOutputs({ teams, tournaments, battles, details });
    return;
  }

  const teams = await fetchLeaderboard();
  await writeJSON(path.join(STATE, 'leaderboard.json'), teams);
  const tournaments = await fetchTournaments();
  await writeJSON(path.join(STATE, 'tournaments.json'), tournaments);
  const { maxAt, newlyDone } = await fetchBattles(battles, cursor);
  await saveBattles(battles);
  cursor.lastAt = maxAt;
  await fetchTeamPages(teams, cursor);
  await writeJSON(path.join(STATE, 'cursor.json'), cursor);
  await fetchDetails(battles, details, newlyDone, teams, cursor);
  await writeJSON(path.join(STATE, 'details.json'), details);
  await writeJSON(path.join(STATE, 'cursor.json'), cursor);

  await writeOutputs({ teams, tournaments, battles, details });
  log(`done: ${stats.requests} requests, ${stats.retries} retries, ${(stats.bytes / 1e6).toFixed(1)} MB`);
}

main().catch((err) => { console.error(err); process.exit(1); });

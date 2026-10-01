#!/usr/bin/env node
// Does per-map Elo predict anything? Hold out the latest ranked games, fit map
// offsets on what came before, and compare log-loss with plain Elo.
//
//   node scripts/check-map-elo.mjs [--state .cache/state] [--holdout-h 12]
import fs from 'node:fs/promises';
import path from 'node:path';
import { G, GK } from '../scraper/rows.mjs';
import { gameRatings, fit, predict } from '../scraper/mapelo.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const STATE = path.resolve(arg('state', '.cache/state'));
const HOLDOUT = Number(arg('holdout-h', 12)) * 3600;

async function loadRows(kind) {
  const dir = path.join(STATE, kind);
  const map = new Map();
  for (const f of (await fs.readdir(dir)).filter((x) => x.endsWith('.json'))) {
    for (const r of JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'))) map.set(r[0], r);
  }
  return map;
}

const battles = await loadRows('battles');
const games = await loadRows('games');
const { rated, linked, rankedGames, missing } = gameRatings(games, battles);
console.log(`${games.size} games stored; ${rated.length} counted and rated; ranked ${rankedGames}, linked to a battle ${linked} (${(100 * linked / rankedGames).toFixed(1)}%), unrated ${missing}`);

const end = rated[rated.length - 1][0][G.at];
const cut = end - HOLDOUT;
const test = rated.filter(([g]) => g[G.at] >= cut && (g[G.kind] & GK.ranked) && g[G.win] !== 0);
console.log(`holdout: ${test.length} decided ranked games after ${new Date(cut * 1000).toISOString()}\n`);

const logloss = (pred) => {
  let s = 0, right = 0;
  for (const [g, ra, rb] of test) {
    const p = Math.min(Math.max(pred(g, ra, rb), 1e-9), 1 - 1e-9);
    const y = g[G.win] === 1;
    s -= y ? Math.log(p) : Math.log(1 - p);
    if ((p > 0.5) === y) right++;
  }
  return { ll: s / test.length, acc: right / test.length };
};
const base = logloss((g, ra, rb) => predict(null, g, ra, rb));
console.log(`plain Elo           log-loss ${base.ll.toFixed(4)}  accuracy ${(100 * base.acc).toFixed(2)}%`);

const rows = [];
for (const days of [1, 3, 7]) {
  for (const tau of [30, 60, 90, 100, 120, 180, 1e4]) {
    for (const joint of [false, true]) {
      if (joint && tau >= 1e4) continue;
      const f = fit(rated, { from: cut - days * 86400, to: cut, tau, joint });
      const r = logloss((g, ra, rb) => predict(f, g, ra, rb));
      rows.push({ days, tau: tau >= 1e4 ? '∞' : tau, joint, ...r });
      console.log(`${days}d τ=${String(tau >= 1e4 ? '∞' : tau).padEnd(4)} ${joint ? 'joint' : 'indep'}  log-loss ${r.ll.toFixed(4)} (${(r.ll - base.ll >= 0 ? '+' : '') + (r.ll - base.ll).toFixed(4)})  accuracy ${(100 * r.acc).toFixed(2)}%`);
    }
  }
}
const best = rows.reduce((a, b) => (b.ll < a.ll ? b : a));
console.log(`\nbest: ${best.days}d τ=${best.tau} ${best.joint ? 'joint' : 'indep'}: log-loss ${best.ll.toFixed(4)} vs ${base.ll.toFixed(4)} plain`);

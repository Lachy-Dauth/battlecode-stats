# Battlecode Stats

An unofficial stats site for [UNSW Battlecode 2026](https://game.battlecode.au), hosted on GitHub Pages: **https://lachy-dauth.github.io/battlecode-stats/**

- **Leaderboard**: by default, only teams with an active bot and the ranked switch on, i.e. the teams you can request ranked battles against. It also shows 24h Elo change, a season trend line, game record, recent activity, switch cooldowns, "new bot" flags, and simulated Sprint and Qualifier odds. You can filter by APAC eligibility, first-year, WGM, UNSW, high school, language, or "teams I can challenge".
- **Map Elo**: every team's Elo on every map in the ranked pool, as a sortable heatmap over the last 24 hours, 3 days or 7 days, plus the top five on each map. A team's map Elo is its official Elo plus an offset for how it does on that map compared with its other maps, fitted from every ranked and tournament game (see below).
- **Team pages**: full Elo and rank history (with an overlay to compare another team), submission history, head-to-head records, map Elo, and recent battles with replay links.
- **Matchup**: single-game odds for any two teams or ratings, the same odds on each map, the distribution of 5-game ranked results, best-of-5 and best-of-7 knockout odds, and whether a ranked challenge is allowed.
- **Odds**: a Monte Carlo simulation of the site's actual Qualifiers bracket (including the Round-of-16 second-chance bracket) into the Grand Final: each team's chance to reach the last 16, qualify directly or through the second-chance bracket, win the Qualifiers, reach the Grand Final's final and win it, plus how many top-10 seeds qualify and the chance a seed 17+ gets through. The Sprint tab shows its results and biggest upsets. You can switch the win-probability model, set rating uncertainty, re-seed the brackets, or override any team's rating.

### Ratings since 1 October

The site reset every rating on 1 Oct and moved to a new system ([docs](https://game.battlecode.au/docs/elo)): each submission has an overall rating and an offset on every map, each with a σ for how sure it is, and a team's ladder rating is its active bot's rating averaged over the ranked map pool. A game on a map is predicted as 1 / (1 + e^(−z/s)), with z the gap (ln 10 / 400 per point, +20 for moving first) and s = √(1 + πv/8) growing with the σs. The odds use that formula by default. Tournament maps are unseen, so each bot's offset there is 0 ± 150; with an assumed ±60 on each bot's overall rating that acts like an Elo divisor of about 518 (about 418 on ranked pool maps). Who moves first is averaged. Tiers moved with the reset (Shark 1900, Swordfish 1500, Tunafish 1100, …), and rating changes are no longer a fixed-K formula, so the Matchup page no longer predicts them.
- **Battles**: a live feed with upset detection.
- **Stats**: Elo calibration (predicted vs. actual game win rate), activity by hour, tier and Elo distributions, movers, languages and countries.

## How it works

```
scraper/        Node 20+, no dependencies
  lib.mjs       polite fetcher (≈3 req/s, retries, backoff) + SvelteKit devalue decoder
  scrape.mjs    leaderboard → tournaments → battles → team pages → match details → games → JSON
  rows.mjs      compact row layouts for stored battles and games
  mapelo.mjs    per-map Elo fit
scripts/
  publish.sh    scrape, push the snapshot to the `data` branch, trigger a redeploy
  check-map-elo.mjs   holdout test of the map Elo fit (log-loss vs plain Elo)
site/           static page, no build step
  js/model.js   Elo maths, series odds, bracket simulator (shared with the worker)
  js/app.js     views + hash router
.github/workflows/deploy.yml   deploy site/ + latest snapshot to Pages
```

game.battlecode.au is a SvelteKit app, and every page exposes its data at `<page>/__data.json`. The scraper reads those public endpoints anonymously: no login, no API key, no cookies.

**Where the scrape runs.** game.battlecode.au refuses requests from GitHub Actions (HTTP 403 from its Cloudflare edge), so the scrape runs on a normal machine with `scripts/publish.sh`. GitHub only hosts the snapshot and deploys it. The site sends no CORS headers either, so the browser can't fetch live data directly.

The accumulated state (every battle seen, plus sampled match details) lives on the `data` branch next to the published JSON. Each publish force-pushes that branch as a single commit, so the repository history doesn't grow. A fresh machine picks up from that state, so only the very first run backfills the whole season (about 15 minutes).

**What an hourly run costs.** About 100 requests and 3 MB, at no more than about 3 requests a second:

| Read | Requests | What for |
|---|---|---|
| Leaderboard | ~10 | Ratings, switches, eligibility, and each team's rank (the rank history) |
| Battle list | ~15 | New battles since the last run |
| Match details | up to 120 | Which bot each team is running; each team is re-checked at most every 2 hours |
| Team pages | only new teams | Read once, for the description and the history from before we started watching |
| Tournaments | ~3 | Brackets |
| Game list | ~25–60 | Every new game with its map and winner (100 per page), for map Elo |

Team pages are never re-read. Every ranked battle carries the pre-battle Elo and the change, so Elo history and win/loss records carry forward from the battle log exactly, and rank history comes from the leaderboard. The data branch is kept locally between runs, so each push uploads only the files that changed.

Knobs: `DETAIL_CAP` (matches sampled per run, default 120) and `RESAMPLE_H` (hours before a team's bot is re-checked, default 2).

The game list was added later. Its first run reads back `GAMES_BACKFILL_DAYS` (default 3) days of games, newest first, one page at a time: about 3,300 requests and 40 minutes at this season's volume. Pages get slower the deeper they go (page 3,000 took about five times as long as page 1), so a longer backfill costs the site disproportionately; the 7-day window simply fills in as runs accumulate. `--games-only` runs just that step, so it can be done outside the hourly job. The games cursor lives in `state/games-cursor.json`, apart from `cursor.json`, so the games state can be copied between machines on its own.

### Map Elo

`/games` lists every game with its map, so map stats use all of them, not a sample. Its Elo columns are each team's *current* rating, though, so ratings at game time come from the battle log: a battle's id is the id of its first game, which links each ranked game to its battle and that battle's pre-battle Elo.

For a game on map *m*, P(*i* beats *j*) = 1 / (1 + 10^(−(R<sub>i</sub> + μ<sub>i</sub> + η<sub>im</sub> − R<sub>j</sub> − η<sub>jm</sub>)/400)). R is the official rating at the time. μ<sub>i</sub> absorbs a team running ahead of or behind its rating over the window (a new bot still climbing), so that doesn't leak into the maps. η<sub>im</sub> is the map offset, with a normal prior centred on 0 so thin maps stay near the team's usual level. Map Elo = current Elo + η. Only ranked and tournament games count, because unranked challenges can use any submission. While ratings were frozen for the Sprint (1 Oct), ranked battles were listed at 1500 v 1500 with no change; games from those battles use each team's last real rating instead.

`node scripts/check-map-elo.mjs` holds out the latest 12 hours of ranked games, fits on the days before, and compares log-loss with plain Elo across windows and prior widths. On two 12-hour holdouts on 1 Oct (23.7k and 15.2k ranked games), map offsets fitted on the days before cut log-loss from 0.590 to about 0.536 and from 0.548 to about 0.518, and raised the share of games called right from 68.0% to about 73% and from 71.8% to about 74.4%. A prior SD (τ) anywhere from 60 to 120 did about equally well; 80 is used. With no prior at all the gain mostly disappears, which is why the offsets are shrunk. Each run also writes a summary of this check to `maps.json`, and the Maps page shows it.

### Submissions

Other teams' bots and upload lists aren't public. Each match does record which submission ID each side played, so the scraper samples at least one recent match per active team every run. It prefers ranked battles, which always use each team's active bot. Unranked challenges can use other submissions for either side. The first run also sampled the top teams' history back to the start of the season. A team page lists each active submission ID with the window it was seen in, plus any other submissions seen only in unranked battles.

## Local development

```bash
npm run scrape    # writes .cache/state and site/data
npm run serve     # http://localhost:8080
npm run publish   # scrape + push the data branch + redeploy Pages (needs an authenticated gh)
```

Environment knobs for the scraper: `SCRAPER_GAP_MS` (default 350), `SCRAPER_CONCURRENCY` (2), `MAX_BATTLE_PAGES`, `DETAIL_CAP`, `RESAMPLE_H`, `TEAM_PAGE_CAP`, `GAMES_BACKFILL_DAYS` (3), `MAX_GAME_PAGES`.

To refresh hourly, schedule `scripts/publish.sh` with cron or launchd, for example:

```
17 * * * * cd /path/to/battlecode-stats && ./scripts/publish.sh >> publish.log 2>&1
```

## Caveats

- This is an unofficial fan site, and all data is already public on game.battlecode.au.
- Tournament brackets are tentative until the organisers re-seed after the final autoscrims.
- The Grand Final format isn't published yet. It is modelled as a seeded single-elimination bracket (best of 5), and the site says so.
- Submission stats come from sampled matches. Map Elo uses every ranked and tournament game since the game list was first read.

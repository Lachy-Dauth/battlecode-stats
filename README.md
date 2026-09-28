# Battlecode Stats

An unofficial stats site for [UNSW Battlecode 2026](https://game.battlecode.au), hosted on GitHub Pages and refreshed every hour.

- **Leaderboard**: by default, only teams with an active bot and the ranked switch on, i.e. the teams you can request ranked battles against. It also shows 24h Elo change, a season trend line, game record, recent activity, switch cooldowns, "new bot" flags, and simulated Sprint and Qualifier odds. You can filter by APAC eligibility, first-year, WGM, UNSW, high school, language, or "teams I can challenge".
- **Team pages**: full Elo and rank history (with an overlay to compare another team), submission history, head-to-head records, per-map win rates, and recent battles with replay links.
- **Matchup**: the Elo-implied single-game odds for any two teams or ratings, the distribution of 5-game ranked results, the rating change for each result (using the site's K = 96 → 24 rule), best-of-5 and best-of-7 knockout odds, and whether a ranked challenge is allowed.
- **Odds**: a Monte Carlo simulation of the site's actual Sprint and Qualifier brackets, plus the Grand Final. You can use pure Elo or an Elo scale fitted to real results, add rating uncertainty, re-seed the brackets, or override any team's Elo.
- **Battles**: a live feed with upset detection.
- **Stats**: Elo calibration (predicted vs. actual game win rate), activity by hour, tier and Elo distributions, movers, languages and countries.

## How it works

```
scraper/        Node 20+, no dependencies
  lib.mjs       polite fetcher (≈3 req/s, retries, backoff) + SvelteKit devalue decoder
  scrape.mjs    leaderboard → tournaments → battles → team pages → match details → JSON
site/           static page, no build step
  js/model.js   Elo maths, series odds, bracket simulator (shared with the worker)
  js/app.js     views + hash router
.github/workflows/update.yml   hourly: scrape, save state, deploy Pages
```

game.battlecode.au is a SvelteKit app, and every page exposes its data at `<page>/__data.json`. The scraper reads those public endpoints, so it needs no login or API key. The site sends no CORS headers, so the browser can't fetch from it directly. The Action therefore snapshots the data and publishes it alongside the page.

The accumulated state (every battle seen, plus sampled match details) lives on a `data` branch. Each run force-pushes that branch as a single commit, so the repository history doesn't grow. The first run backfills the whole battle history, which takes about 15 minutes. Later runs take a minute or two.

### Submissions

Other teams' bots and upload lists aren't public. Each match does record which submission ID each side played, so the scraper samples at least one recent match per active team every run. On its first run it also samples the top 100 teams roughly every 8 hours back to the start of the season. A team page lists each submission ID with the window it was seen in. Its record only counts battles that fall between two sightings of that same submission.

## Local development

```bash
npm run scrape   # writes .cache/state and site/data (first run ≈15 min)
npm run serve    # http://localhost:8080
```

Environment knobs for the scraper: `SCRAPER_GAP_MS` (default 350), `SCRAPER_CONCURRENCY` (2), `MAX_BATTLE_PAGES`, `DETAIL_CAP`, `BACKFILL_TEAMS`, `BACKFILL_DETAIL_CAP`, `TEAM_PAGE_CAP`.

## Deploying

1. Push this repository to GitHub.
2. Under **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Run the **Update stats** workflow, or wait for the hourly schedule.

## Caveats

- This is an unofficial fan site, and all data is already public on game.battlecode.au.
- Tournament brackets are tentative until the organisers re-seed after the final autoscrims.
- The Grand Final format isn't published yet. It is modelled as a seeded single-elimination bracket (best of 5), and the site says so.
- Map and submission stats come from sampled matches.

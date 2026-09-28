# Battlecode Stats

An unofficial stats site for [UNSW Battlecode 2026](https://game.battlecode.au), hosted on GitHub Pages: **https://lachy-dauth.github.io/battlecode-stats/**

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
scripts/
  publish.sh    scrape, push the snapshot to the `data` branch, trigger a redeploy
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

Team pages are never re-read. Every ranked battle carries the pre-battle Elo and the change, so Elo history and win/loss records carry forward from the battle log exactly, and rank history comes from the leaderboard. The data branch is kept locally between runs, so each push uploads only the files that changed.

Knobs: `DETAIL_CAP` (matches sampled per run, default 120) and `RESAMPLE_H` (hours before a team's bot is re-checked, default 2).

### Submissions

Other teams' bots and upload lists aren't public. Each match does record which submission ID each side played, so the scraper samples at least one recent match per active team every run. It prefers ranked battles, which always use each team's active bot. Unranked challenges can use other submissions for either side. The first run also sampled the top teams' history back to the start of the season. A team page lists each active submission ID with the window it was seen in, plus any other submissions seen only in unranked battles.

## Local development

```bash
npm run scrape    # writes .cache/state and site/data
npm run serve     # http://localhost:8080
npm run publish   # scrape + push the data branch + redeploy Pages (needs an authenticated gh)
```

Environment knobs for the scraper: `SCRAPER_GAP_MS` (default 350), `SCRAPER_CONCURRENCY` (2), `MAX_BATTLE_PAGES`, `DETAIL_CAP`, `RESAMPLE_H`, `TEAM_PAGE_CAP`.

To refresh hourly, schedule `scripts/publish.sh` with cron or launchd, for example:

```
17 * * * * cd /path/to/battlecode-stats && ./scripts/publish.sh >> publish.log 2>&1
```

## Caveats

- This is an unofficial fan site, and all data is already public on game.battlecode.au.
- Tournament brackets are tentative until the organisers re-seed after the final autoscrims.
- The Grand Final format isn't published yet. It is modelled as a seeded single-elimination bracket (best of 5), and the site says so.
- Map and submission stats come from sampled matches.

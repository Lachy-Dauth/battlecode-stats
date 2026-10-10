#!/usr/bin/env bash
# Follow a live tournament: every few minutes, fetch just the brackets and push
# tournaments.json to the `live` branch (one parentless commit). The site reads
# it from raw.githubusercontent.com and uses it when it's newer than the
# hourly snapshot, so results show up within a few minutes without a redeploy.
#
#   scripts/live.sh [interval-seconds] [stop-at-HH:MM]   # e.g. scripts/live.sh 180 23:30
set -euo pipefail
cd "$(dirname "$0")/.."
EVERY="${1:-180}"
STOP="${2:-}"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
URL="https://github.com/$REPO.git"
DIR=.cache/live
mkdir -p "$DIR/out"
[ -d "$DIR/repo/.git" ] || git init -q -b live "$DIR/repo"
while :; do
  if node scraper/scrape.mjs --tournaments-only --state "$DIR/state" --out "$DIR/out"; then
    cp "$DIR/out/tournaments.json" "$DIR/repo/tournaments.json"
    (
      cd "$DIR/repo"
      git add -A
      commit=$(git -c user.name="battlecode-stats" -c user.email="battlecode-stats@users.noreply.github.com" \
        commit-tree "$(git write-tree)" -m "Live brackets $(date -u +%Y-%m-%dT%H:%MZ)")
      git update-ref refs/heads/live "$commit"
      git push -q -f "$URL" live 2>&1 | grep -v '^remote:' || true
    )
    echo "live: pushed $(date +%H:%M:%S)"
  fi
  if [ -n "$STOP" ] && [ "$(date +%H:%M)" \> "$STOP" ]; then break; fi
  sleep "$EVERY"
done

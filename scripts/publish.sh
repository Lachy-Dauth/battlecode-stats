#!/usr/bin/env bash
# Scrape game.battlecode.au from this machine, publish the snapshot to the
# `data` branch (always a single commit), and trigger a Pages redeploy.
#
#   scripts/publish.sh            # needs node >= 20, git and an authenticated gh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
URL="https://github.com/$REPO.git"

# First run on a new machine: continue from the published state.
if [ ! -d .cache/state ]; then
  rm -rf .cache/seed
  if git clone -q --depth 1 --branch data "$URL" .cache/seed 2>/dev/null; then
    mkdir -p .cache && mv .cache/seed/state .cache/state
  fi
  rm -rf .cache/seed
fi

node scraper/scrape.mjs --state .cache/state --out site/data

OUT=.cache/databranch
rm -rf "$OUT" && mkdir -p "$OUT"
cp -R .cache/state "$OUT/state"
cp -R site/data "$OUT/public"
(
  cd "$OUT"
  git init -q -b data
  git add -A
  git -c user.name="battlecode-stats" -c user.email="battlecode-stats@users.noreply.github.com" \
    commit -q -m "Data snapshot $(date -u +%Y-%m-%dT%H:%MZ)"
  git push -q -f "$URL" data
)
rm -rf "$OUT"
gh workflow run deploy.yml -R "$REPO" --ref main
echo "Published $(date)"

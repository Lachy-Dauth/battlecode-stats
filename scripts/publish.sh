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

# The data branch is always a single commit, but the local copy of it is kept
# between runs: the previous snapshot is still here when pushing, so git only
# uploads the files that changed instead of the whole snapshot.
OUT=.cache/databranch
if [ ! -d "$OUT/.git" ]; then rm -rf "$OUT"; mkdir -p "$OUT"; git -C "$OUT" init -q -b data; fi
rsync -a --delete .cache/state/ "$OUT/state/"
rsync -a --delete site/data/ "$OUT/public/"
(
  cd "$OUT"
  git add -A
  commit=$(git -c user.name="battlecode-stats" -c user.email="battlecode-stats@users.noreply.github.com" \
    commit-tree "$(git write-tree)" -m "Data snapshot $(date -u +%Y-%m-%dT%H:%MZ)")
  git update-ref refs/heads/data "$commit"
  if ! out=$(git push --progress -f "$URL" data 2>&1); then echo "$out" >&2; exit 1; fi
  printf '%s\n' "$out" | tr '\r' '\n' | grep -E "Writing objects: 100%" | tail -1 || true
  # Drop older snapshots from the local store; the one just pushed stays for next time.
  git reflog expire --expire=now --all
  git gc -q --prune=now
)
gh workflow run deploy.yml -R "$REPO" --ref main
echo "Published $(date)"

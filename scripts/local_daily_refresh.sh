#!/usr/bin/env bash
# Daily Checkee refresh, run from a residential IP.
#
# Why local: GitHub Actions hosts on Azure datacenter IPs that Cloudflare
# bot-management blanket-403s for checkee.info, regardless of TLS fingerprint
# (we tried curl_cffi Chrome impersonation; still 403). Running from this
# machine's home IP returns 200.
#
# This script is meant to be invoked by launchd (see
# scripts/install_local_refresh_cron.sh) but can also be run by hand:
#   bash scripts/local_daily_refresh.sh
#
# Operates in a dedicated checkout at $CHECKEE_CRON_HOME so it never touches
# your dev clone's working tree or branch state.

set -euo pipefail

CRON_HOME="${CHECKEE_CRON_HOME:-$HOME/Library/Application Support/checkee-cron}"
CHECKOUT="$CRON_HOME/checkout"
VENV="$CRON_HOME/venv"
LOG_DIR="$HOME/Library/Logs/checkee"
LOG="$LOG_DIR/refresh.log"
LOCK="$LOG_DIR/refresh.lock"

mkdir -p "$LOG_DIR"
exec >>"$LOG" 2>&1

echo
echo "==== $(date -u +%FT%TZ) refresh start (host=$(hostname -s)) ===="

# Concurrency guard: mkdir is atomic on macOS HFS+/APFS.
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "another refresh is in progress (lock=$LOCK); abort"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

if [ ! -d "$CHECKOUT/.git" ]; then
  echo "ERROR: $CHECKOUT is not a git checkout. Run install_local_refresh_cron.sh first."
  exit 1
fi

if [ ! -x "$VENV/bin/python" ]; then
  echo "ERROR: $VENV is missing. Run install_local_refresh_cron.sh first."
  exit 1
fi

PY="$VENV/bin/python"

cd "$CHECKOUT"

# Sync the dedicated checkout to latest main. Force-reset is safe here
# because nothing else writes into this directory.
git fetch --quiet origin main
git checkout --quiet main
git reset --hard --quiet origin/main

# Skip if dataset is fresh (< 36h). Mirrors the gate the old CI workflow had,
# so a manual run that fires shortly before / after the cron does not double-
# fetch from upstream.
if "$PY" - <<'PY'
import json, sys
from datetime import datetime, timezone
from pathlib import Path

p = Path("data/checkee/crawl_summary.json")
if not p.exists():
    print("no prior summary; proceeding")
    sys.exit(1)
g = json.loads(p.read_text()).get("generated_at", "")
if not g:
    print("summary missing generated_at; proceeding")
    sys.exit(1)
last = datetime.fromisoformat(g)
if last.tzinfo is None:
    last = last.replace(tzinfo=timezone.utc)
age = (datetime.now(tz=timezone.utc) - last).total_seconds() / 3600
if age < 36:
    print(f"data is {age:.1f}h old (< 36h); skipping")
    sys.exit(0)
print(f"data is {age:.1f}h old; proceeding")
sys.exit(1)
PY
then
  exit 0
fi

END_DATE="$(date -u +%F)"

echo "scraper start end_date=$END_DATE"
"$PY" -m check_trending.checkee_scraper daily \
  --start-date 2025-07-01 \
  --end-date "$END_DATE" \
  --bucket auto \
  --probe-count 80 \
  --fetch-budget 1000 \
  --delay-seconds 3 \
  --jitter-seconds 4 \
  --retries 1 \
  --timeout 30 \
  --max-failure-rate 0.20

echo "build_web_data start"
"$PY" scripts/build_web_data.py

if [ -z "$(git status --porcelain data/checkee public/data/app-data.json)" ]; then
  echo "no dataset changes; nothing to commit"
  exit 0
fi

git add data/checkee public/data/app-data.json
COMMIT_AUTHOR_NAME="${CHECKEE_COMMIT_NAME:-checkee-local-cron}"
COMMIT_AUTHOR_EMAIL="${CHECKEE_COMMIT_EMAIL:-$(git config --get user.email || echo cron@localhost)}"
git -c "user.name=$COMMIT_AUTHOR_NAME" \
    -c "user.email=$COMMIT_AUTHOR_EMAIL" \
    commit -m "Daily refresh: $END_DATE (local cron)"

# Push, with one rebase-retry if upstream moved between fetch and push.
if ! git push --quiet origin main; then
  echo "push rejected; rebasing onto latest origin/main and retrying once"
  git pull --rebase --quiet origin main
  git push --quiet origin main
fi
echo "pushed."

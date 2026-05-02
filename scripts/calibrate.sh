#!/usr/bin/env bash
# Path 2 — Manual monthly-listing calibration.
#
# Run this on a residential IP (your home machine, not CI) when you want to
# verify the canonical dataset against checkee.info's authoritative monthly
# listings. A real Chrome window will open so you can watch the Cloudflare
# challenge resolve.
#
# Calibration log lives at data/checkee/monthly_calibration_log.json; it
# tracks which months have been calibrated so this script doesn't re-fetch
# settled history every run. The hard rule (current + previous month always)
# is enforced inside the scraper.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if ! python3 -c "import patchright" 2>/dev/null; then
  echo "[calibrate] installing patchright..."
  pip install --quiet patchright
  patchright install chromium --no-shell
fi

END_DATE="${END_DATE:-$(date +%F)}"

echo "[calibrate] running monthly listing calibration through $END_DATE"
python3 -m check_trending.checkee_scraper calibrate \
  --start-date 2025-07-01 \
  --end-date "$END_DATE" \
  --delay-seconds 3 \
  --jitter-seconds 4 \
  --retries 1 \
  --timeout 30 \
  "$@"

echo "[calibrate] done. Latest report:"
ls -1t data/checkee/reports/reconciliation/*.json 2>/dev/null | head -1 || true

echo
echo "Review the diff and commit if you're happy:"
echo "  git status data/checkee public/data"

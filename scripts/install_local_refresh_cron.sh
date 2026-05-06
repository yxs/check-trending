#!/usr/bin/env bash
# One-time installer for the local launchd cron that replaces the
# disabled GitHub Actions schedule.
#
#   bash scripts/install_local_refresh_cron.sh
#
# Idempotent: re-running upgrades the venv, re-clones if needed, and
# reloads the launchd job.
#
# Uninstall:
#   launchctl unload "$HOME/Library/LaunchAgents/com.user.checkee-daily-refresh.plist"
#   rm "$HOME/Library/LaunchAgents/com.user.checkee-daily-refresh.plist"
#   rm -rf "$HOME/Library/Application Support/checkee-cron"

set -euo pipefail

LABEL="com.user.checkee-daily-refresh"
CRON_HOME="${CHECKEE_CRON_HOME:-$HOME/Library/Application Support/checkee-cron}"
CHECKOUT="$CRON_HOME/checkout"
VENV="$CRON_HOME/venv"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_AGENTS/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/checkee"

# Resolve the repo URL from the current directory (the user's dev clone) by
# default. Override with CHECKEE_REPO_URL if you want a different remote.
REPO_URL="${CHECKEE_REPO_URL:-$(git -C "$(dirname "$0")/.." config --get remote.origin.url 2>/dev/null || true)}"
if [ -z "$REPO_URL" ]; then
  echo "ERROR: cannot resolve repo URL. Set CHECKEE_REPO_URL or run from inside a clone." >&2
  exit 1
fi

PYTHON3="$(command -v python3 || true)"
if [ -z "$PYTHON3" ]; then
  echo "ERROR: python3 not found on PATH." >&2
  exit 1
fi

mkdir -p "$CRON_HOME" "$LAUNCH_AGENTS" "$LOG_DIR"

if [ -d "$CHECKOUT/.git" ]; then
  echo "[install] checkout exists; fetching latest main"
  git -C "$CHECKOUT" fetch --quiet origin main
  git -C "$CHECKOUT" checkout --quiet main
  git -C "$CHECKOUT" reset --hard --quiet origin/main
else
  echo "[install] cloning $REPO_URL → $CHECKOUT"
  git clone --quiet "$REPO_URL" "$CHECKOUT"
fi

if [ ! -x "$VENV/bin/python" ]; then
  echo "[install] creating venv at $VENV"
  "$PYTHON3" -m venv "$VENV"
fi

echo "[install] installing dependencies into venv"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet 'curl_cffi>=0.7'

chmod +x "$CHECKOUT/scripts/local_daily_refresh.sh"

echo "[install] writing $PLIST"
cat >"$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$CHECKOUT/scripts/local_daily_refresh.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CHECKEE_CRON_HOME</key>
    <string>$CRON_HOME</string>
    <key>PATH</key>
    <string>$(dirname "$PYTHON3"):/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
    <dict>
      <key>Weekday</key><integer>1</integer>
      <key>Hour</key><integer>13</integer>
      <key>Minute</key><integer>37</integer>
    </dict>
    <dict>
      <key>Weekday</key><integer>3</integer>
      <key>Hour</key><integer>13</integer>
      <key>Minute</key><integer>37</integer>
    </dict>
    <dict>
      <key>Weekday</key><integer>5</integer>
      <key>Hour</key><integer>13</integer>
      <key>Minute</key><integer>37</integer>
    </dict>
  </array>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/launchd.err.log</string>
</dict>
</plist>
PLIST_EOF

# Reload (unload silently if not already loaded).
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

cat <<EOF

[install] done.
  label:     $LABEL
  checkout:  $CHECKOUT
  venv:      $VENV
  plist:     $PLIST
  log:       $LOG_DIR/refresh.log
  schedule:  Mon/Wed/Fri 13:37 local time

verify:
  launchctl list | grep checkee
trigger now:
  launchctl start $LABEL && tail -f "$LOG_DIR/refresh.log"
uninstall:
  launchctl unload "$PLIST" && rm "$PLIST" && rm -rf "$CRON_HOME"
EOF

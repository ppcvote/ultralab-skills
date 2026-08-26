#!/usr/bin/env bash
# heartbeat-check.sh — watch your watchdogs.
#
# Why: when a monitor dies, alerts stop, and silence reads exactly like health.
# This is the most expensive shape of silent failure because every light stays green.
#
# How it works:
#   each watchdog writes a unix timestamp after a successful run:
#     date +%s > "$HB_DIR/$(basename "$0" .sh)"
#   this script checks every file in that directory, including its own.
#
# Schedule it. Linux and macOS (crontab -e):
#   */30 * * * * /usr/bin/env bash /path/to/heartbeat-check.sh >> /tmp/hb.log 2>&1
# Windows (PowerShell, via WSL or Git Bash):
#   schtasks /create /tn "heartbeat-check" /sc minute /mo 30 ^
#     /tr "bash C:\path\to\heartbeat-check.sh"
#
# Honest limitation: this script cannot detect its own death on the same host. If it
# stops being scheduled, nothing notices. Pair it with an external dead-man's switch
# (healthchecks.io, Cronitor, or a second host) using PING_URL below.
#
# Environment:
#   HB_DIR     heartbeat directory (default: $HOME/.heartbeats)
#   MAX_AGE    seconds before a heartbeat counts as stale (default: 5400)
#   PING_URL   optional external dead-man's switch to ping on each successful run
set -uo pipefail

HB_DIR="${HB_DIR:-$HOME/.heartbeats}"
MAX_AGE="${MAX_AGE:-5400}"
SELF="$(basename "$0" .sh)"

mkdir -p "$HB_DIR"

notify() {
  echo "[ALERT] $*"
  # Send alerts down a different path from the thing being monitored. If the alert
  # rides the same pipe that just broke, you never hear about it.
  if [ -n "${TG_BOT_TOKEN:-}" ] && [ -n "${TG_CHAT_ID:-}" ]; then
    curl -sf -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
      -H 'Content-Type: application/json' \
      -d "$(printf '{"chat_id":"%s","text":"%s"}' "$TG_CHAT_ID" "$*")" >/dev/null || true
  fi
}

now=$(date +%s)
found=0
stale=0
broken=0

for f in "$HB_DIR"/*; do
  [ -e "$f" ] || continue
  found=$((found + 1))
  name=$(basename "$f")

  # A corrupt or empty heartbeat must not kill this loop. Under `set -u`, arithmetic
  # on a non-numeric value aborts the whole script, every remaining watchdog goes
  # unchecked, and the final self-heartbeat write never runs. Guard it explicitly.
  last=$(tr -cd '0-9' < "$f" 2>/dev/null || true)
  if [ -z "$last" ]; then
    broken=$((broken + 1))
    notify "heartbeat file is empty or corrupt: $name (treat as down until proven otherwise)"
    continue
  fi

  age=$((now - last))
  if [ "$age" -lt 0 ]; then
    notify "heartbeat is in the future: $name (clock skew, or a bad write)"
    continue
  fi
  if [ "$age" -gt "$MAX_AGE" ]; then
    stale=$((stale + 1))
    notify "heartbeat stopped: $name has not updated in ${age}s (limit ${MAX_AGE}s)"
  fi
done

# An empty directory is more suspicious than a stale entry: it usually means the path
# is wrong or the directory was wiped, not that everything is fine.
if [ "$found" -eq 0 ]; then
  notify "heartbeat directory is empty: $HB_DIR. Either no watchdog is writing, or the path is wrong."
fi

# Write our own heartbeat last, so a crash above leaves this one stale and visible.
date +%s > "$HB_DIR/$SELF"

# External dead-man's switch: this is what catches this script's own death.
if [ -n "${PING_URL:-}" ]; then
  curl -sf --max-time 10 "$PING_URL" >/dev/null || echo "[WARN] dead-man's switch ping failed"
fi

echo "checked=$found stale=$stale broken=$broken"

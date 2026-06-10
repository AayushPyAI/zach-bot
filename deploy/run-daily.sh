#!/usr/bin/env bash
#
# Daily runner for the Reddit bot. Invoked by launchd (macOS) or cron.
# Resolves the project directory relative to this script, so it works wherever
# the repo lives. Logs to logs/daily.log.
#
# The bot's own gates (active hours, daily cap, min/max gap, per-subreddit
# cooldown, random skip) handle pacing — this just wakes it up on a schedule.
set -euo pipefail

# Project root = parent of this script's directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# Make common Node install locations visible to launchd/cron (minimal PATH).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

mkdir -p logs
echo "=== run $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> logs/daily.log

# --live posts for real (subject to caps/gaps). Use --dry-run to rehearse.
npm run dev -- --live >> logs/daily.log 2>&1

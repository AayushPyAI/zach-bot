#!/usr/bin/env bash
#
# 24/7 daemon runner. Launched by the KeepAlive launchd job. Runs the bot in
# --loop mode, which starts human-like sessions at randomized intervals forever.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

mkdir -p logs

# --live posts for real (subject to caps/gaps). Drop --live to run draft-only.
exec npm run start -- --loop --live

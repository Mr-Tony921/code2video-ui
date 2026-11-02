#!/usr/bin/env bash
set -euo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 "$R/scripts/service.py" bridge start "${CVW_WORKER_ID:-${1:?worker id required}}"

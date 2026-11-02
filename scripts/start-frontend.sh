#!/usr/bin/env bash
set -euo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 "$R/scripts/service.py" web "${1:-start}"

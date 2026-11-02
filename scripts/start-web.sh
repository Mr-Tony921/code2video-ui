#!/usr/bin/env bash
set -euo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"
exec bash "$R/scripts/start-frontend.sh" "${1:-start}"

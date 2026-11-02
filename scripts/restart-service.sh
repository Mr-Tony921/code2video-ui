#!/usr/bin/env bash
set -euo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 "$R/scripts/service.py" "${1:?gateway or bridge}" restart "${2:-}"

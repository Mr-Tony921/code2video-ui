#!/usr/bin/env bash
set -euo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"
source "$R/scripts/node-guard.sh"
require_node18 e2e
exec node "$R/scripts/verify-runtime.mjs" "$@"

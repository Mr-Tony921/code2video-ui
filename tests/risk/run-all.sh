#!/usr/bin/env bash
# Failure-mode regressions. Logs and fixtures belong to this invocation only.
set -euo pipefail
R="$(cd "$(dirname "$0")/../.." && pwd)"
. "$R/scripts/node-guard.sh"
require_node18 'Risk tests'
python3 "$R/scripts/guard-isolation.py"
OUT=$(mktemp -d "$R/runtime/validation/risk.XXXXXX")
P=0; F=0
for t in pool-verify tailer-test tailer-risk adopt-unit crash-test isolate-test selfheal-risk maint-risk enhance-kill-path enhance-no-block sse-leak asset-gating session-slot session-id-display context-config argv-safety round-isolation round-count resume-guards stale-artifact assistant-text example-video adopt-token asset-delivery cancel-settle concurrency-cap stream-leak asset-preview skill-scripts capacity-dispatch poll-payload; do
  if node "$R/tests/risk/$t.mjs" >"$OUT/$t.log" 2>&1; then
    echo "PASS $t"; P=$((P+1))
  else
    echo "FAIL $t ($OUT/$t.log)"; F=$((F+1))
  fi
done
echo "Passed $P, failed $F; logs $OUT"
[ "$F" = 0 ]

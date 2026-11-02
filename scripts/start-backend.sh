#!/usr/bin/env bash
set -euo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"
ACTION="${1:-start}"
WORKER="${CVW_WORKER_ID:-$(python3 - "$R" <<'PYWORKER'
import json,socket,sys
from pathlib import Path
c=json.loads((Path(sys.argv[1])/'config/backend.json').read_text())
ips=socket.gethostbyname_ex(socket.gethostname())[2]
print(next(w['worker_id'] for w in c['workers'] if w['bridge']['host'] in ips))
PYWORKER
)}"
python3 "$R/scripts/service.py" gateway "$ACTION"
exec python3 "$R/scripts/service.py" bridge "$ACTION" "$WORKER"

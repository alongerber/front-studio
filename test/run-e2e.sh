#!/bin/sh
# Starts the local e2e server, runs the browser tests, stops the server.
set -eu
cd "$(dirname "$0")/.."
node test/e2e-server.js 8787 > /tmp/e2e-server.log 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT HUP INT TERM
python3 - <<'PY'
import time, urllib.request
for attempt in range(100):
    try:
        urllib.request.urlopen('http://localhost:8787/api/config', timeout=1).close()
        break
    except OSError:
        time.sleep(0.1)
else:
    raise SystemExit('The local e2e server did not become ready; see /tmp/e2e-server.log')
PY
python3 -u test/e2e.py

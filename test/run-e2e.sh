#!/bin/sh
# Starts the local e2e server, runs the browser tests, stops the server.
cd "$(dirname "$0")/.."
node test/e2e-server.js 8787 > /tmp/e2e-server.log 2>&1 &
PID=$!
sleep 3
python3 test/e2e.py; CODE=$?
kill $PID
exit $CODE

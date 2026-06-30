#!/bin/bash
cd "$(dirname "$0")"

PORT=7777
PIDS=$(lsof -ti tcp:$PORT 2>/dev/null)
if [ -n "$PIDS" ]; then
  echo "Stopping previous WNCleaning server (PID $PIDS)…"
  kill $PIDS 2>/dev/null
  sleep 1
  PIDS=$(lsof -ti tcp:$PORT 2>/dev/null)
  if [ -n "$PIDS" ]; then
    kill -9 $PIDS 2>/dev/null
    sleep 1
  fi
fi

exec /usr/bin/env node server.js

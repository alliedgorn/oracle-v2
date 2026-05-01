#!/usr/bin/env bash
set -euo pipefail

DENBOOK_DIR="/home/gorn/workspace/denbook"
PORT=47778
LOG="/tmp/denbook-server.log"
ENV_FILE="/home/gorn/.oracle/.env"

cd "$DENBOOK_DIR"

echo "=== Den Book Deploy ==="

# 1. Pull merged commits
echo "[1/6] Pulling main..."
BEFORE=$(git rev-parse HEAD)
git pull origin main
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  echo "No new commits. Nothing to deploy."
  exit 0
fi

echo "Deploy payload: $BEFORE..$AFTER"
git log --oneline "$BEFORE..$AFTER"

# 2. Check for dependency changes
if git diff --name-only "$BEFORE" "$AFTER" | grep -q 'package.json\|bun.lock'; then
  echo "[2/6] Dependencies changed — running bun install..."
  bun install
else
  echo "[2/6] No dependency changes — skipping install."
fi

# 3. Check for frontend changes and rebuild if needed
if git diff --name-only "$BEFORE" "$AFTER" | grep -q '^frontend/src/'; then
  echo "[3/6] Frontend changes detected — rebuilding..."
  cd frontend && npm run build && cd ..
  echo "Frontend rebuilt."
else
  echo "[3/6] No frontend changes — skipping build."
fi

# 4. Stop current server
echo "[4/6] Stopping server..."
pkill -TERM -f 'bun.*server.ts' 2>/dev/null || true
sleep 2
if curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
  echo "WARNING: Server still up after SIGTERM — sending SIGKILL..."
  kill -9 $(lsof -ti :"$PORT") 2>/dev/null || true
  sleep 1
fi
echo "Server stopped."

# 5. Start fresh
echo "[5/6] Starting server..."
(set -a && . "$ENV_FILE" && set +a && nohup bun run src/server.ts > "$LOG" 2>&1 &)
disown 2>/dev/null || true
sleep 4

# 6. Smoke check
echo "[6/6] Smoke check..."
if curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
  echo "✓ Health OK"
else
  echo "✗ Health FAILED — check $LOG"
  tail -20 "$LOG"
  exit 1
fi

echo ""
echo "=== Deploy complete: $(git rev-parse --short HEAD) ==="
echo "Payload: $(git log --oneline "$BEFORE..$AFTER" | wc -l) commits"

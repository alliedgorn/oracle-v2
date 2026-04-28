#!/bin/bash
# Beast self-rotate CLI helper — Spec #52 Phase 3.
#
# Reads BEAST_TOKEN from the worktree's .env, calls POST /api/auth/rotate,
# and writes the new token back via in-place line-replace (atomic
# mktemp + chmod 600 + rename, mode 0077 umask, same-FS temp).
#
# Discipline (Bertus v4 §A + §B + Gnarl v4 .env-canonical):
#   - .env MUST exist + have ^BEAST_TOKEN= line; never auto-create or auto-append
#   - Token bytes NEVER echo to stdout/stderr/clipboard/history
#   - Atomic write via mktemp on same FS as .env; chmod 600 before rename
#   - Preserves all other .env keys (in-place line-replace, not whole-file rewrite)
#   - Transitional fallback to ~/.oracle/tokens/<beast> per v4 (drop in v5)
#
# Usage:
#   bash scripts/rotate-token.sh
#   (run from inside the Beast's worktree; sources .env from the cwd)
#
# Stdout (on success): one-line metadata, NEVER token bytes.
# Exit codes:
#   0   rotated successfully
#   1   .env missing or BEAST_TOKEN line missing (Bertus §B)
#   2   server unreachable / network error
#   3   server returned non-200 (auth failure, window-expired, rotation-locked, etc.)
#   4   atomic write failed

set -u  # unset-var guard. NOT -e because we want explicit exit-code mapping.

ENV_FILE="${ENV_FILE:-./.env}"
SERVER="${ORACLE_SERVER:-http://localhost:47778}"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env not found at $ENV_FILE — refusing to auto-create (Bertus §B failure-mode discipline)" >&2
  exit 1
fi

if ! grep -q '^BEAST_TOKEN=' "$ENV_FILE"; then
  echo "ERROR: ^BEAST_TOKEN= line not present in $ENV_FILE — refusing to silent-append (Bertus §B failure-mode discipline)" >&2
  exit 1
fi

# Source .env to load BEAST_TOKEN. Do not echo it.
set -a
. "$ENV_FILE"
set +a

if [ -z "${BEAST_TOKEN:-}" ]; then
  echo "ERROR: BEAST_TOKEN is empty after sourcing $ENV_FILE" >&2
  exit 1
fi

# Call /api/auth/rotate. Capture body + status separately.
HTTP_RESP=$(curl -sS -o /tmp/rotate-token-body.$$ -w "%{http_code}" \
  -X POST "$SERVER/api/auth/rotate" \
  -H "Authorization: Bearer $BEAST_TOKEN" \
  -H "Content-Type: application/json" \
  --data-raw '{}' 2>/dev/null) || {
    echo "ERROR: curl failed (server unreachable at $SERVER)" >&2
    rm -f /tmp/rotate-token-body.$$
    exit 2
  }

if [ "$HTTP_RESP" != "200" ]; then
  echo "ERROR: rotate returned HTTP $HTTP_RESP" >&2
  cat /tmp/rotate-token-body.$$ >&2
  echo >&2
  rm -f /tmp/rotate-token-body.$$
  exit 3
fi

# Parse new token from response. Use Python (always available where bun runs)
# for robust JSON parsing without an extra dep.
NEW_TOKEN=$(python3 -c "import json,sys;d=json.load(open('/tmp/rotate-token-body.$$'));print(d['token'])" 2>/dev/null) || {
  echo "ERROR: failed to parse 'token' field from response" >&2
  rm -f /tmp/rotate-token-body.$$
  exit 3
}
EXPIRES_AT=$(python3 -c "import json,sys;d=json.load(open('/tmp/rotate-token-body.$$'));print(d.get('expires_at',''))" 2>/dev/null)
NEW_TOKEN_ID=$(python3 -c "import json,sys;d=json.load(open('/tmp/rotate-token-body.$$'));print(d.get('id',''))" 2>/dev/null)
BEAST_NAME=$(python3 -c "import json,sys;d=json.load(open('/tmp/rotate-token-body.$$'));print(d.get('beast',''))" 2>/dev/null)
rm -f /tmp/rotate-token-body.$$

# Atomic in-place line-replace on .env per Bertus §A.
# umask 0077 ensures temp inherits owner-only perms before content is written.
# Same-FS temp via mktemp -p so rename is atomic (kernel guarantee).
ENV_DIR=$(dirname "$ENV_FILE")
TMP=$(umask 0077 && mktemp "$ENV_DIR/.env.rotate.XXXXXX") || {
  echo "ERROR: mktemp failed in $ENV_DIR" >&2
  exit 4
}

# Read .env, replace ^BEAST_TOKEN= line, write to temp.
# Use awk for the line-replace so other keys are untouched character-for-character.
awk -v tok="$NEW_TOKEN" '
  /^BEAST_TOKEN=/ { print "BEAST_TOKEN=" tok; next }
  { print }
' "$ENV_FILE" > "$TMP" || {
  rm -f "$TMP"
  echo "ERROR: awk line-replace failed" >&2
  exit 4
}

# Belt + suspenders: chmod 600 explicitly even though umask should have set it.
chmod 600 "$TMP" || { rm -f "$TMP"; echo "ERROR: chmod 600 failed" >&2; exit 4; }
mv -f "$TMP" "$ENV_FILE" || { rm -f "$TMP"; echo "ERROR: rename failed" >&2; exit 4; }

# Transitional fallback per Spec #52 v4: also write ~/.oracle/tokens/<beast>
# with mode 600 during the cutover window. Drop in v5 once all callers
# source .env BEAST_TOKEN exclusively.
if [ -n "$BEAST_NAME" ] && [ -d "$HOME/.oracle/tokens" ]; then
  FALLBACK="$HOME/.oracle/tokens/$BEAST_NAME"
  TMP_FB=$(umask 0077 && mktemp "$HOME/.oracle/tokens/.rotate.XXXXXX") || true
  if [ -n "${TMP_FB:-}" ]; then
    printf '%s\n' "$NEW_TOKEN" > "$TMP_FB"
    chmod 600 "$TMP_FB"
    mv -f "$TMP_FB" "$FALLBACK"
  fi
fi

# Stdout: metadata only. NEVER token bytes.
echo "Rotated. New token id: $NEW_TOKEN_ID. Expires at: $EXPIRES_AT. Old token revoked (chain-linked via rotated_at + next_token_id)."
exit 0

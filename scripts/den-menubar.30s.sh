#!/bin/bash
# Den Book Menu Bar Plugin (xbar/SwiftBar compatible)
# Shows DM unread count badge in the macOS menu bar.
# Install: copy to ~/Library/Application Support/xbar/plugins/ (xbar)
#          or ~/Library/Application Support/SwiftBar/plugins/ (SwiftBar)
#
# Polls every 30 seconds (configurable via filename: den-menubar.30s.sh)
# Requires: curl, jq
# T#535

DEN_URL="${DEN_URL:-https://denbook.online}"
# Session cookie for authenticated access (set in env or paste here)
DEN_COOKIE="${DEN_COOKIE:-}"

# Fetch DM unread count (lightweight endpoint)
if [ -n "$DEN_COOKIE" ]; then
  RESPONSE=$(curl -s --max-time 5 -H "Cookie: session=$DEN_COOKIE" "$DEN_URL/api/dm/unread-count" 2>/dev/null)
else
  RESPONSE=$(curl -s --max-time 5 "$DEN_URL/api/dm/unread-count" 2>/dev/null)
fi

# Parse unread count
if command -v jq &>/dev/null && [ -n "$RESPONSE" ]; then
  UNREAD=$(echo "$RESPONSE" | jq '.unread // 0' 2>/dev/null)
else
  UNREAD=0
fi

# Menu bar title — show icon + count (or just icon if 0)
ICON="🐾"
if [ "$UNREAD" -gt 0 ]; then
  echo "$ICON $UNREAD | color=red"
else
  echo "$ICON"
fi

# Dropdown menu
echo "---"
echo "Den Book | href=$DEN_URL"
echo "Direct Messages | href=$DEN_URL/dms"
echo "---"

if [ "$UNREAD" -gt 0 ]; then
  echo "📬 $UNREAD unread DMs"
else
  echo "✅ No unread DMs"
fi

echo "---"
echo "Refresh | refresh=true"

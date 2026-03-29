#!/bin/bash
# Den notification queue — enqueue a message for a Beast
# Usage: notify.sh <beast> <message>
# All notification senders call this instead of tmux send-keys directly.

BEAST=$(echo "$1" | tr '[:upper:]' '[:lower:]')
MESSAGE="$2"
QUEUE_DIR="/tmp/den-notify"
QUEUE_FILE="$QUEUE_DIR/$BEAST.queue"
LOCK_FILE="$QUEUE_DIR/$BEAST.lock"

if [ -z "$BEAST" ] || [ -z "$MESSAGE" ]; then
  echo "Usage: notify.sh <beast> <message>" >&2
  exit 1
fi

mkdir -p "$QUEUE_DIR"

# Base64 encode to safely handle newlines, quotes, special chars
ENCODED=$(echo -n "$MESSAGE" | base64 -w 0)

# Atomic append with flock
flock "$LOCK_FILE" bash -c "echo '$ENCODED' >> '$QUEUE_FILE'"

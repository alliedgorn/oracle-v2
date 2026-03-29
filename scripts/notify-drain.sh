#!/bin/bash
# Den notification queue — drain loop for a Beast
# Usage: notify-drain.sh <beast> <tmux-session>
# Started by /wakeup, stopped by /rest

BEAST=$(echo "$1" | tr '[:upper:]' '[:lower:]')
SESSION="$2"
QUEUE_DIR="/tmp/den-notify"
QUEUE_FILE="$QUEUE_DIR/$BEAST.queue"
LOCK_FILE="$QUEUE_DIR/$BEAST.lock"
PID_FILE="$QUEUE_DIR/$BEAST.pid"
SPACING=3  # seconds between sends

if [ -z "$BEAST" ] || [ -z "$SESSION" ]; then
  echo "Usage: notify-drain.sh <beast> <tmux-session>" >&2
  exit 1
fi

mkdir -p "$QUEUE_DIR"
echo $$ > "$PID_FILE"

# Cleanup PID file on exit
trap "rm -f '$PID_FILE'" EXIT

while true; do
  if [ -s "$QUEUE_FILE" ]; then
    # Atomically read and remove first line
    ENCODED=$(flock "$LOCK_FILE" bash -c "head -1 '$QUEUE_FILE' && sed -i '1d' '$QUEUE_FILE'")

    if [ -n "$ENCODED" ]; then
      # Decode from base64
      MSG=$(echo "$ENCODED" | base64 -d 2>/dev/null)

      if [ -n "$MSG" ]; then
        # Send to tmux — use -l flag for literal text
        tmux send-keys -t "$SESSION" -l "$MSG"
        tmux send-keys -t "$SESSION" Enter
        sleep "$SPACING"
      fi
    fi
  else
    sleep 1  # poll interval when queue is empty
  fi
done

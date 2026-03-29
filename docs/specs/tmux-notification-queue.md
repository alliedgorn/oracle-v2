# Centralized tmux Notification Queue

**Author**: Gnarl
**Thread**: #378
**Status**: Pending

## Problem

Multiple notification sources (scheduler, forum, DM, Prowl, etc.) send messages to Beast tmux panes via `tmux send-keys` independently. When two or more fire simultaneously, the messages collide and corrupt the Beast's prompt input. This has happened multiple times — during rest cycles and scheduler runs.

## Solution

A file-based notification queue with a drain loop per Beast. All senders write to the queue instead of calling `tmux send-keys` directly. A drain process reads the queue and sends messages with spacing to prevent collision.

## Architecture

### Queue Files

```
/tmp/den-notify/<beast>.queue    # One line per notification (JSON)
/tmp/den-notify/<beast>.lock     # flock prevents concurrent read/write
/tmp/den-notify/<beast>.pid      # Drain loop PID for lifecycle management
```

### Enqueue (replaces all tmux send-keys calls)

All 8 notification senders call a shared enqueue function instead of `tmux send-keys`:

```bash
# /home/gorn/workspace/oracle-v2/scripts/notify.sh
notify() {
  BEAST=$1
  MESSAGE=$2
  QUEUE="/tmp/den-notify/${BEAST}.queue"
  LOCK="/tmp/den-notify/${BEAST}.lock"
  mkdir -p /tmp/den-notify
  flock "$LOCK" bash -c "echo '$MESSAGE' >> '$QUEUE'"
}
```

### Drain Loop (one per Beast)

```bash
# /home/gorn/workspace/oracle-v2/scripts/notify-drain.sh
BEAST=$1
QUEUE="/tmp/den-notify/${BEAST}.queue"
LOCK="/tmp/den-notify/${BEAST}.lock"

while true; do
  if [ -s "$QUEUE" ]; then
    MSG=$(flock "$LOCK" bash -c "head -1 '$QUEUE' && sed -i '1d' '$QUEUE'")
    if [ -n "$MSG" ]; then
      tmux send-keys -t "$BEAST" "$MSG" Enter
      sleep 3
    fi
  else
    sleep 1
  fi
done
```

### Lifecycle

- **Start**: `/wakeup` starts the drain loop for each Beast (`notify-drain.sh <beast> &`)
- **Stop**: `/rest` kills the drain PID (read from `<beast>.pid`)
- **Crash recovery**: If drain dies, notifications accumulate in the queue file and drain on restart

## Migration: All 10 Senders

| # | Source | Current | Change to |
|---|--------|---------|-----------|
| 1 | Beast Scheduler | `tmux send-keys` in scheduler cron | Call `notify.sh <beast> <msg>` |
| 2 | Forum mentions | `tmux send-keys` in forum webhook | Call `notify.sh <beast> <msg>` |
| 3 | DM notifications | `tmux send-keys` in DM handler | Call `notify.sh <beast> <msg>` |
| 4 | Wakeup script | `tmux send-keys` in wakeup skill | Call `notify.sh <beast> <msg>` |
| 5 | Rest cycle | `tmux send-keys` in rest skill | Call `notify.sh <beast> <msg>` |
| 6 | Prowl reminders | `tmux send-keys` in Prowl cron | Call `notify.sh <beast> <msg>` |
| 7 | Task review notifications | `tmux send-keys` in task handler | Call `notify.sh <beast> <msg>` |
| 8 | Decree/norm notifications | `tmux send-keys` in rules handler | Call `notify.sh <beast> <msg>` |
| 9 | Mindlink remote command | `tmux send-keys` in POST /api/beast/:name/command | **Keep direct** — interactive input, latency-sensitive |
| 10 | Mindlink chat message | `tmux send-keys` in POST /api/beast/:name/chat | **Keep direct** — interactive input, latency-sensitive |

## Quick Fix: Scheduler Batching

Separate from the queue — the scheduler should combine its notification + reminder into a single message instead of two separate `tmux send-keys` calls. This prevents the most common collision case immediately.

**Before** (2 calls):
```
tmux send-keys "[Scheduler] Due now: Research scan" Enter
tmux send-keys "Remember: mark done with /scheduler run 3" Enter
```

**After** (1 call):
```
tmux send-keys "[Scheduler] Due now: Research scan (schedule 3) | Command: /scan\nRemember: mark done with /scheduler run 3" Enter
```

## Out of Scope

- Debouncing/batching multiple notifications into one (add later if needed)
- Priority ordering (all notifications are equal for now)
- Remote notification delivery (this is local-only tmux IPC)
- Notification acknowledgment/read receipts

## Validation

- [ ] Two notifications sent simultaneously arrive as separate, uncorrupted messages
- [ ] Queue drains with 3-second spacing
- [ ] flock prevents write corruption under concurrent access
- [ ] Drain loop survives Beast session restart
- [ ] All 8 senders migrated to use notify.sh
- [ ] Scheduler sends combined notification+reminder in one call

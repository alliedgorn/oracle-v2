#!/bin/bash
# Den notification queue — drain loop for a Beast (Spec #54 v2)
# Usage: notify-drain.sh <beast> <tmux-session>
# Started by /wakeup wake-order in Beast brain CLAUDE.md, stopped by /rest or machine reboot.
# Canonical install path: /home/gorn/workspace/<beast>/scripts/notify-drain.sh
# Legacy path: /home/gorn/workspace/denbook/scripts/notify-drain.sh (superseded; runtime self-validate skips this path)

BEAST=$(echo "$1" | tr '[:upper:]' '[:lower:]')
SESSION="$2"
QUEUE_DIR="/tmp/den-notify"
QUEUE_FILE="$QUEUE_DIR/$BEAST.queue"
LOCK_FILE="$QUEUE_DIR/$BEAST.lock"
PID_FILE="$QUEUE_DIR/$BEAST.pid"
LOG_FILE="/tmp/notify-drain-$BEAST.log"
SPACING=3  # seconds between sends

if [ -z "$BEAST" ] || [ -z "$SESSION" ]; then
  echo "Usage: notify-drain.sh <beast> <tmux-session>" >&2
  exit 1
fi

# Spec #54 v2 §C — /tmp permissions discipline. Defense-in-depth + future-proof
# against multi-user regression. Force secure mode at queue-dir + per-Beast files.
umask 0077
mkdir -p "$QUEUE_DIR"
chmod 0700 "$QUEUE_DIR" 2>/dev/null || true

# Spec #54 v3 (Pip DEN-FM10651 §T15 PARTIAL FAIL fold): chmod LOG_FILE explicitly.
# /tmp/notify-drain-<beast>.log is created by the wake-order parent-shell redirect
# (`> /tmp/notify-drain-<beast>.log 2>&1`) BEFORE this script's umask 0077 fires.
# Parent-shell default umask (typically 022) yields mode 644 = world-readable on /tmp.
# Mara Phase 2 wake-order ALSO prefixes `umask 0077;` before the redirect (template
# layer); this drain.sh chmod is the redundant safety net at the script-execution
# layer (same belt+suspenders pattern as E1 tmux pre-check). Closes log-readable
# class regardless of which layer enforces.
[ -e "$LOG_FILE" ] && chmod 0600 "$LOG_FILE" 2>/dev/null || true

# Spec #54 v2 §B / E2 — Cross-Beast queue read self-validation.
# Drain.sh fails fast if $BEAST arg does NOT match brain-worktree directory name.
# Closes misconfig-as-cross-Beast-disclosure class (e.g. Karo's drain misconfig'd
# to read Bertus's queue would tmux-paste Bertus's notifications including DM
# bodies). Fail-fast at script-start, no test-cycle observation needed.
#
# Skip self-validate when running from denbook/scripts/ legacy path (script
# is superseded there per pre-Spec-#54 architecture; runtime executor moved to
# Beast brain via Mara Phase 1+2 fold).
# Spec #54 v3 (Pip DEN-FM10651 §T14 SOFT case-sensitivity fold): lowercase
# SCRIPT_DIR for the comparison. $BEAST is already lowercased (line 7) but
# SCRIPT_DIR was not. Doesn't fire in current prod (12/12 Beast brain-dirs all
# lowercase) but real fragility worth closing pre-merge.
# Spec #54 v4 (Phase 3 oracle-v2 → denbook rename fold per DEN-FT549): legacy-path
# carve-out updated from "oracle-v2" to "denbook" since prod worktree was renamed
# in Phase 2 at 15:07 BKK (2026-04-27). Without this update, drain.sh self-validate
# fires FATAL on any execution from the renamed prod path.
SCRIPT_DIR="$(basename "$(dirname "$(dirname "$(readlink -f "$0")")")")"
SCRIPT_DIR=$(echo "$SCRIPT_DIR" | tr '[:upper:]' '[:lower:]')
if [ "$SCRIPT_DIR" != "denbook" ] && [ "$SCRIPT_DIR" != "$BEAST" ]; then
  echo "FATAL: drain beast-arg '$BEAST' does not match brain-worktree '$SCRIPT_DIR' (cross-Beast queue-read prevention per Spec #54 v2 §B/E2)" >&2
  exit 2
fi

# Spec #54 v2 E1 (defense-in-depth) — tmux session pre-check at script-start.
# Mara Phase 2 wake-order is the primary lifecycle gate (`tmux has-session ||
# nohup ... &`); this drain-side check is the redundant safety net per Bertus
# DEN-FM10645 — closes wake-order-bypass-manual-drain-start class. If drain.sh
# is invoked via any path other than canonical wake-order (operator manual
# restart, debug invocation, future auto-restart logic), single-layer gate breaks.
# Same trust-no-caller-validate-at-script-start family as E2 self-validate above.
# Fail-loud BEFORE PID-file flock acquisition or PID write — no zombie-PID class,
# no flock orphan.
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "FATAL: tmux session '$SESSION' not found for $BEAST drain (wake-order-bypass safety net per Spec #54 v2 E1 defense-in-depth)" >&2
  exit 4
fi

# Spec #54 v2 §E3 — Drain-instance flock at PID-file layer.
# Closes pgrep TOCTOU double-start race: two concurrent /wakeup fires can both
# pgrep-empty before either drain writes PID. PID-file flock ensures one drain
# instance per Beast even under wake-order race.
exec 9<>"$PID_FILE"
chmod 0600 "$PID_FILE" 2>/dev/null || true
if ! flock -x -n 9; then
  echo "FATAL: another drain instance holds the PID-file flock for $BEAST (drain-startup race prevention per Spec #54 v2 §E3)" >&2
  exit 3
fi
echo $$ > "$PID_FILE"

# Cleanup PID file on exit (graceful exit only; SIGKILL/OOM detected by server-side
# perBeastDrainAlive cmdline-check per Spec #54 v2 §1).
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
        # T#713: sleep between text-paste and Enter to break the race with
        # Claude Code's Ink TUI renderer. Without this delay, Enter could land
        # mid-frame while the input field was still rendering the paste, and
        # the message would sit stuck in the input instead of submitting.
        sleep 0.2
        tmux send-keys -t "$SESSION" Enter
        sleep "$SPACING"
      fi
    fi
  else
    sleep 1  # poll interval when queue is empty
  fi
done

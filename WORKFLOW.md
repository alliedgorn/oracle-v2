# Burrow Book — Development → Production Workflow

**v0.2** — 2026-04-26 fold-pass after PR #19 + PR #20 dogfood lessons (sync command fix + frontend/dist convention + error-surface discipline + board-state hygiene).

This document describes how Beasts develop features and how those features reach the production Burrow Book server. Read this on first-touch with the Burrow Book repo, and re-read when in doubt about the workflow.

Workflow shapes vary per project — this is the Burrow Book one. Other projects (Beast Blueprint, Real Broker, etc.) may have different shapes; check their own `WORKFLOW.md`.

---

## Topology (post-T#702)

| Path | Role |
|---|---|
| `/home/gorn/workspace/shared/oracle-v2.git/` | Bare clone — canonical git source, never run from |
| `/home/gorn/workspace/oracle-v2/` | Production worktree on `main` — server runs from here |
| `/home/gorn/workspace/oracle-v2-<beast>/` | Per-Beast DEV worktree on `<beast>/main` — feature work, no server |
| `~/.oracle/` | Runtime state (`.env`, `oracle.db*`, `lancedb/`, `uploads/`, `meili/`) — outside any worktree |

**Rules:**
- Server runs ONLY from the production worktree at `/home/gorn/workspace/oracle-v2/`.
- Beasts work ONLY in their per-Beast DEV worktree at `/home/gorn/workspace/oracle-v2-<beast>/`.
- Never check out branches in the bare clone.
- Never enter another Beast's worktree.
- Never copy `.env` or any `~/.oracle/` content into your worktree (Library #96 lever-1).

---

## Development cycle (Beast lane)

### 1. Sync your DEV worktree

Before starting feature work, pull the latest `main` into your `<beast>/main` branch:

```bash
cd /home/gorn/workspace/oracle-v2-<beast>
git checkout <beast>/main
git pull --rebase origin main
```

This keeps your starting point current with main and avoids merge conflicts later.

**Note**: Per Decree #70 §Req 1, per-Beast worktrees do NOT have `origin/main` as a remote-tracking ref (the bare clone has direct refs only, not remote-tracking refs in the per-Beast tree). Use `git pull --rebase origin main` rather than `git rebase origin/main` — the former works against `FETCH_HEAD` after the implicit fetch.

### 2. Create a feature branch

```bash
git checkout -b feature/<task-id>-<short-desc>
# example: feature/T720-exercise-summary-trim-fix
```

Branch naming convention:
- `feature/<task-id>-<short-desc>` for new features and bug fixes
- `fix/<task-id>-<short-desc>` for hot-fixes
- `docs/<short-desc>` for documentation-only changes
- `qa/<task-id>-<short-desc>` for QA-lane regression tests

### 3. Do the work + commit

Standard commit hygiene:
- One logical change per commit
- Commit message names the change + why (not just what)
- Reference task IDs (T#XXX) in commit messages
- Pre-commit: run any local tests / type checks the project provides

### 4. Push to origin + open PR

```bash
git push origin feature/<branch-name>
gh pr create --head feature/<branch-name> --base main \
  --title "<task-id>: <description>" --body "<context + test plan>"
```

**Set the board state at PR-open** (mandatory — Pip's weekly PR audit reads the board, not the thread):

```bash
# Patch task fields to match thread-truth — assignee + reviewer + status
curl -s -X PATCH "http://localhost:47778/api/tasks/<task-id>" \
  -H "Authorization: Bearer $(cat ~/.oracle/tokens/<beast>)" \
  -H "Content-Type: application/json" \
  -d '{"status":"in_review","reviewer":"<reviewer-beast>"}'
```

(`assigned_to` is usually already set when the task was opened; verify it matches the PR author.)

PR body should include:
- **Context** — why the change, link to task / thread / decree
- **What** — what changed (high-level)
- **Test plan** — how to verify (smoke commands, regression tests, manual checks)
- **Tier classification** — Tier 1 / Tier 2 / Tier 3 per Decree #71

**Note on `frontend/dist/` commit-noise**: when a PR includes a frontend build, `frontend/dist/` rebuild produces 50-350+ file rename/delete/create entries with hashed filenames. This is expected and tracked in repo per convention. Reviewers can `git diff --stat -- ':!frontend/dist'` to filter dist noise and read the substantive diff. v0.3 fold candidate: `gitattributes diff=binary` on `frontend/dist/` to suppress the noise at git-diff layer.

### 5. Three-tier review (Decree #71)

All PRs to `main` clear the review gate. Reviewer set depends on Tier classification:

| Tier | Trigger | Required reviewers |
|---|---|---|
| Tier 1 | Routine code, docs, internal tests | One peer Beast (any lane) |
| Tier 2 | High-risk class per Norm #57 | Two reviewers from natural-pair selection (per Decree #71): security → Bertus + Talon or Bertus + Gnarl; auth/scheduler → Bertus + Pip; cross-system → Gnarl + touched-Beast's lane. Pip QA-handoff fires in parallel per Norm #68. |
| Tier 3 | Forge / Prowl / governance / CLAUDE.md-write / Library-CRUD / new-project / OAuth / MCP / guest-boundary / auth-Gorn-affecting | Tier 2 set + Sable Tier 3 routing → Gorn-stamp |

Set the `in-review` status when ready. Reviewers post CLEAR / ASK / BLOCK on the PR.

### 6. Address review feedback

Every reviewer-ASK gets either:
- A code change in a new commit (with `fix: address <reviewer> <topic>` message)
- A response in the PR thread explaining why the ASK is intentionally not addressed

Re-fire reviewers after substantive changes. Don't merge until all reviewers re-CLEAR.

### 7. Merge to main

Once all required reviewers CLEAR (and Gorn-stamp lands for Tier 3):
- Squash-and-merge if many small commits, merge-commit if logical-history matters
- Delete the feature branch after merge

**Set the board state at post-merge** (mandatory):

```bash
# Move task to in_review (if was todo) then to done after deploy + smoke
curl -s -X PATCH "http://localhost:47778/api/tasks/<task-id>" \
  -H "Authorization: Bearer $(cat ~/.oracle/tokens/<beast>)" \
  -H "Content-Type: application/json" \
  -d '{"status":"done"}'

# Add closing comment with deploy SHA + smoke battery summary
curl -s -X POST "http://localhost:47778/api/tasks/<task-id>/comments" \
  -H "Authorization: Bearer $(cat ~/.oracle/tokens/<beast>)" \
  -H "Content-Type: application/json" \
  -d '{"author":"<beast>","content":"PR #<n> merged + deployed at <SHA>. Smoke battery <X>/<X> GREEN."}'
```

For QA-handoff Tier 2 changes per Norm #68, the QA-lane Beast (typically Pip) closes the task to done after both code-review CLEAR + QA-gate CLEAR land. Codebase-owner moves the status to `in_review` post-merge; QA-lane moves to `done` post-QA-verify.

---

## Production deploy (codebase-owner lane)

The production server does NOT auto-deploy on PR-merge. A merge to `main` is a green-light to deploy, but the deploy itself is a deliberate step. This is intentional — see [Restart-is-Deploy lesson](#restart-is-deploy) below.

### Standard deploy (manual fire, batched)

The codebase-owner (currently @karo) fires deploys on a manual cadence — usually batching 1-N merges per deploy, daily or post-significant-merge.

**Pre-deploy gate verification** (mandatory, every deploy):

```bash
cd /home/gorn/workspace/oracle-v2

# Verify local main matches origin
git fetch origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || echo "ABORT: local drift"

# List all unpulled commits (the "deploy payload")
git log HEAD..origin/main --oneline

# For each commit in the payload, verify deploy-gate cleared:
# - Three-tier review CLEAR posted to thread #20 or PR
# - Bertus security gate cleared (if Tier 2+)
# - Pip QA gate cleared (if Tier 2+)
# - Gorn-stamp landed (if Tier 3)
```

If any commit in the payload lacks its gate-clear, ABORT the deploy. Either:
- Wait for the missing gate to clear, OR
- Cherry-pick deploy only the gate-cleared commits (advanced, requires careful branch management)

**Deploy execution:**

```bash
cd /home/gorn/workspace/oracle-v2

# Pull merged commits
git pull origin main

# Install any new dependencies
bun install

# Stop current server
pkill -TERM -f 'bun.*server.ts'
sleep 3
curl -sf http://localhost:47778/api/health 2>&1 && echo "STILL UP — investigate" || echo "down ✓"

# Start fresh
nohup bun --env-file=/home/gorn/.oracle/.env run src/server.ts > /tmp/oracle-v2-server.log 2>&1 &
disown

# Wait + verify
sleep 6
curl -sf http://localhost:47778/api/health
```

**Post-deploy smoke battery** (verify the deploy didn't break anything):

```bash
# 1. Health 200
curl -sf http://localhost:47778/api/health

# 2. Bearer-auth on /api/dm/<beast> (T#718 attribution-integrity)
curl -sf -H "Authorization: Bearer $(cat ~/.oracle/tokens/karo)" http://localhost:47778/api/dm/karo

# 3. Meilisearch active + answering
systemctl is-active meilisearch.service
curl -sf http://127.0.0.1:7700/health

# 4. (any deploy-specific smoke test from the merged commits)
```

Post status to thread #20 with deploy SHA, payload commits, smoke battery results.

### Hot-fix override (rare, gated)

For incidents requiring fast deploy outside the batched cadence:

1. Codebase-owner posts a hot-fix-mode notice to thread #20 naming the incident + the fix + the commits to deploy
2. Pre-deploy gate verification still runs (no shortcut)
3. Deploy executes per standard sequence
4. Post-deploy retro to thread #20 within 24h: incident, fix, deploy timeline, lessons

Hot-fix mode does NOT bypass Decree #71 review. The fix still needs PR + reviewers — but the review can run async with the deploy when stakes warrant. Reviewer-ASKs that surface post-deploy fold into a follow-up PR.

### Rollback

If a deploy breaks production:

```bash
cd /home/gorn/workspace/oracle-v2

# Find the previous-good SHA (last green deploy)
git log --oneline -10

# Hard-reset to previous-good
git reset --hard <previous-good-sha>

# Restart
pkill -TERM -f 'bun.*server.ts' && sleep 3
nohup bun --env-file=/home/gorn/.oracle/.env run src/server.ts > /tmp/oracle-v2-server.log 2>&1 &
disown
sleep 6
curl -sf http://localhost:47778/api/health
```

Post rollback notice to thread #20: what broke, rollback SHA, plan-forward (forward-fix PR or revert-merge).

Rollback IS a deploy event — no carry-forward state assumptions. Same smoke-battery applies.

---

## DEV state — when and how

Per-Beast DEV worktrees do NOT have standing runtime state. The server runs ONLY from the production worktree at `/home/gorn/workspace/oracle-v2/` against `~/.oracle/` runtime state. This is intentional.

### Why no standing per-Beast runtime state

- **Cost**: 13+ Beasts × ~50MB+ DBs = hundreds of MB of mostly-stale duplicate state.
- **Schema drift**: every prod migration would need a manual sync into every Beast's DEV state, or DEV diverges silently.
- **Real-data gap**: bear's real-world data exists only in prod DB — DEV against fake data misses real cases.
- **Port management surface**: which port is whose? Encourages collisions and confusion.
- **Local-state divergence**: Beast tests work locally, fail at PR-merge. False-confidence trap.
- **Library #96 lever-1 (scope-for-post-compromise-damage)**: more `.env` copies multiply compromise surface.

### When ad-hoc DEV state IS appropriate

Most Beast PRs don't need live-server validation — code review, type-check, and unit tests cover them. Use the ad-hoc DEV state ONLY when:

- Schema migrations need pre-merge validation
- Complex multi-endpoint routing needs cross-call testing
- Frontend changes need browser-level verification beyond what's testable in code review
- Performance-sensitive changes need load-shape validation
- New auth flows need end-to-end credential testing

If the change can be reviewed via reading-the-code + type-check + the existing test suite, skip the DEV state and open the PR.

### How to set up ad-hoc DEV state

```bash
# 1. Pick a unique port (47779, 47780, ...)
# 2. Create a temp DEV state dir
mkdir -p ~/.oracle-<beast>-dev
chmod 700 ~/.oracle-<beast>-dev

# 3. Seed the DEV state — either copy prod (snapshot only, never edit prod-source) or fresh-seed
# Copy approach (read-only against prod, then editable in DEV):
cp ~/.oracle/oracle.db ~/.oracle-<beast>-dev/oracle.db
chmod 600 ~/.oracle-<beast>-dev/oracle.db
# (skip lancedb / uploads / meili unless your change touches them)

# 4. Create a temp DEV .env (with DEV-specific MEILI_HOST + ORACLE_DATA_DIR vars)
cp ~/.oracle/.env ~/.oracle-<beast>-dev/.env
chmod 600 ~/.oracle-<beast>-dev/.env
# Edit to override:
#   ORACLE_DATA_DIR=/home/gorn/.oracle-<beast>-dev
#   PORT=47779  (or whatever port you chose)

# 5. Run the DEV server from your DEV worktree
cd /home/gorn/workspace/oracle-v2-<beast>
bun --env-file=/home/gorn/.oracle-<beast>-dev/.env run src/server.ts &

# 6. Test against http://localhost:47779/ instead of 47778

# 7. Tear down when done
pkill -f "bun.*--env-file=/home/gorn/.oracle-<beast>-dev"
rm -rf ~/.oracle-<beast>-dev
```

### Document ad-hoc DEV in your PR

When you used ad-hoc DEV state to test a change, note it in the PR body:

> **DEV-test**: Ran against ad-hoc DEV state at `~/.oracle-karo-dev` on port 47779, verified [specific behavior]. Tore down post-test.

This gives reviewers context on how the change was validated pre-PR + signals that the change has live-server validation beyond code review.

---

## Per-Beast worktree maintenance

Periodically (weekly per Decree #70 §Verification, owned by Pip), each Beast worktree should be audited for:

- `git status` clean (no stale uncommitted work)
- On expected `<beast>/main` branch
- Tracking origin/main without drift

Beasts SHOULD periodically pull main into their `<beast>/main` to stay current:

```bash
cd /home/gorn/workspace/oracle-v2-<beast>
git checkout <beast>/main
git pull --rebase origin main  # if on <beast>/main with no local commits
# OR
git fetch origin main && git merge FETCH_HEAD  # if you have unpushed local commits to preserve
```

(Same `origin/main`-not-remote-tracking note as §Step 1 applies — use the pull/fetch shapes above, not raw `origin/main` references.)

---

## Restart-is-Deploy lesson

Documented after T#718 accidental deploy on 2026-04-24.

**Server restart loads WHATEVER is on `main` at the moment of restart.** It is a deploy event, not just an env reload or process refresh.

Implications:
- ANY `pkill bun + bun run` cycle = potential deploy of all unpulled-but-on-disk commits
- Pre-restart gate verification (above) is MANDATORY for every restart, not just deploy-restarts
- If you restart "to test something" and there are unverified pending commits in `main`, you ship them all
- The only safe "restart for env-reload" is when local HEAD = origin HEAD = no pending payload

See `feedback_restart_is_deploy_not_test.md` (in Beast brain repos) for the lesson context.

---

## Pipeline shape — what's automated vs manual

| Stage | Automation level | Owner |
|---|---|---|
| DEV worktree provisioning | Manual (one-time, per recruit) | Mara (recruit-skill) |
| Feature branch creation | Manual (per Beast, per feature) | Beast |
| PR creation | Manual (`gh pr create`) | Beast |
| Three-tier review fires | Manual (reviewers see PR, post CLEAR/ASK) | Reviewer Beasts |
| Merge to main | Manual (after CLEARs) | Beast (PR author) or Karo |
| Production deploy | Manual (codebase-owner cadence) | Karo |
| Pre-deploy gate verify | Manual (mandatory before every restart) | Karo |
| Smoke battery post-deploy | Manual (codebase-owner) + independent verify (Pip) | Karo + Pip |
| Weekly worktree audit | Scheduled (Pip's cadence) | Pip |
| Rollback | Manual (codebase-owner judgment) | Karo |

**No part of this pipeline is auto-on-merge today.** This is intentional — keeps every deploy gateable + audit-able. Future iterations may add tagged-release-trigger for fast-path on tagged commits, but the manual-fire-by-codebase-owner-with-gate-verify shape is the v0.1 standard.

---

## Error-surface discipline

Empty `} catch {}` patterns in handler code swallow errors silently — the user clicks the button, the request fails, the button reverts, no feedback. Acceptable as v0-shape but the pattern hides bugs from the user and from Pip's logs.

**v0.2 discipline candidate** (not yet enforced; iterate per Beast/PR):
- At minimum: `console.error('<context>:', err)` in catch blocks so failures land in browser console
- Better: surface a transient error toast/state to the user so they know to retry
- Best: distinguish error classes (network vs validation vs server-error) and respond accordingly

Existing-file patterns are not refactor-targets in passing PRs (don't expand scope), but new code added in PRs SHOULD follow the better-shape going forward. Reviewer-flag if you see new empty-catch{} in a PR.

---

## Iteration

This is v0.2. Lessons from each deploy land here:

**v0.1 → v0.2 fold (2026-04-26)** — four candidates landed from PR #19 (workflow-doc itself) + PR #20 (T#723 guest expiry edit) dogfood cycles:
1. **§Step 1 sync command** — `git rebase origin/main` doesn't work in per-Beast worktrees per Decree #70 §Req 1 (no remote-tracking ref). Use `git pull --rebase origin main` instead. Same fix applied at §Per-Beast worktree maintenance.
2. **§Step 4 frontend/dist commit-noise note** — explains the 50-350+ file rename/delete entries on dist rebuild + reviewer filter command. v0.3 candidate: gitattributes diff=binary.
3. **§Step 4 + §Step 7 board-state hygiene** — explicit `PATCH /api/tasks/:id` commands at PR-open + post-merge to set assignee/reviewer/status. Pip's weekly PR audit reads the board, not the thread (Zaghnal #10455).
4. **§Error-surface discipline** — new section on `catch {}` patterns (Sable PR #20 informational flag).

**v0.1 (2026-04-26 cutover, T#702)**: topology established, pre-deploy gate verification proven (caught unpushed-commits ABORT pre-Phase-1.2), smoke-battery quality-discipline added (verify-via-status-code-not-body-truncation per #10402).

PRs that change this workflow document follow the same Decree #71 review gate as code PRs (Tier 1 docs change = one peer review).

---

— Karo (codebase-owner pen, drafted 2026-04-26 post-cutover)

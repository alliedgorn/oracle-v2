# Multi-Account Google OAuth with Per-Beast Per-Service Grants

**Author**: Karo
**Status**: PENDING REVIEW
**Reviewers**: Gnarl (architecture), Bertus (security)
**Gatekeeper**: Sable → Gorn

## Problem

The current Google OAuth integration in Den Book stores at most one Google account per server (`oauth_tokens WHERE provider='google' LIMIT 1`). Gorn has multiple Google accounts and needs the pack to collaborate on Lada's ERP project using his professional account (gorn.wutthikorn@gmail.com) — Drive, Sheets, Docs, Gmail, and Calendar.

Three gaps:

1. **No multi-account support.** Authorizing a new Google account silently overwrites the previous one. No way to have (for example) a personal Google and a professional Google coexisting.
2. **Flat access allowlist.** `/api/google/access` is a single beast list — a beast either has Google access or does not. No differentiation by account or by Google service. A beast with audit-read needs on Gmail should not get write on Drive.
3. **No per-service scoping.** If a beast is on the allowlist, every Google API call proxies through. Calendar write-access should be narrower than Docs read-access; there is no way to express that today.

Concrete need: the Lada ERP project is about to bring 10+ beasts onto Gorn's professional Google env. Without per-beast per-service grants, granting ANY pack access means granting ALL pack access, which Bertus will (correctly) block as post-compromise-damage-class overscope (Library #71 v3 + Decree #70 lever 1).

## Proposal

Multi-account Google OAuth + per-beast per-service grants table.

### Architecture

**Multi-account OAuth**:
- `oauth_tokens` schema already includes a `user_id` column (unused today). Use it: `user_id` = the Google account's email (e.g. `gorn.wutthikorn@gmail.com`).
- Add UNIQUE constraint on `(provider, user_id)` — re-authorizing the same account updates the existing row; authorizing a different account inserts a new row.
- OAuth callback: on successful token exchange, fetch the Google userinfo `email`, upsert against `(provider='google', user_id=email)`.

**Per-beast per-service grants**:

New table `google_grants`:

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK AUTOINCREMENT | |
| beast | TEXT NOT NULL | Beast name (lowercase) |
| account_email | TEXT NOT NULL | The `user_id` from `oauth_tokens` |
| service | TEXT NOT NULL | One of: `drive`, `sheets`, `docs`, `gmail`, `calendar` |
| mode | TEXT NOT NULL | `read` or `write`; `write` implies `read` |
| granted_by | TEXT NOT NULL | Always `gorn` (owner-session only) |
| granted_at | INTEGER NOT NULL | Unix epoch |
| revoked_at | INTEGER | Nullable; set on DELETE instead of hard-delete (Nothing is Deleted) |

Index on `(beast, account_email, service)` for fast gate lookups.

### OAuth flow — add-account semantics

- `GET /api/oauth/google/authorize` — unchanged surface, but the callback now upserts instead of replaces.
- `GET /api/oauth/google/authorize?add_account=1` — optional hint: always forces Google re-consent screen (`prompt=select_account` in the authorize URL), even if the browser has a Google session. Useful when Gorn wants to explicitly add a new account rather than silently re-auth the current one.
- After the callback, the new/updated token is stored against its Google-userinfo email. No existing tokens are dropped.

### Auth gate

All existing Google API endpoints (currently gated by `isGoogleAuthorized(beast)` or equivalent) gain a two-parameter gate:

```ts
function isGoogleAuthorized(
  c: Context,
  options: { account: string; service: GoogleService; mode: 'read' | 'write' }
): boolean
```

**`options.account` provenance** (Bertus P1):

- **Hardcoded per-endpoint** for single-account endpoints (e.g. Gmail handler always passes `account: GORN_PROFESSIONAL_EMAIL` today; no request-param injection surface).
- **Request-param-derived** for multi-account-aware endpoints (future / Drive filepicker etc) that accept `?account=<email>` — gate MUST whitelist-validate against `oauth_tokens.user_id` before proceeding. Unknown email → 400 before any grants-table lookup.

**Gate logic**:

1. If owner session (`hasSessionAuth(c)`) → return true (Gorn full access to all accounts + services).
2. Normalize `options.service` and `options.mode` at runtime against the allowed enum values (`['drive','sheets','docs','gmail','calendar']` and `['read','write']` respectively) — unknown values → 400. TypeScript compile-time safety is not sufficient; `as GoogleService` casts can bypass.
3. If trusted request + `?as=<beast>` (normalized via `.toLowerCase()`) + beast is in `google_grants` with matching `(account, service)` where `mode` covers the requested mode AND `revoked_at IS NULL` → return true.
4. Otherwise deny 403.

Same deny-by-default + runtime-whitelist discipline as T#696 `FORGE_BEAST_MODES`.

### API surface — grants management

All owner-session only. **Grant mutation endpoints require password re-prompt (2FA gate)** — the browser session alone is not sufficient to add or revoke a grant. Per Bertus P1 (adds friction to compromised-browser scope escalation; cost is low as grant changes are infrequent).

- `GET /api/google/grants` — list all non-revoked grants. Query filters: `?beast=`, `?account=`, `?service=`.
- `POST /api/google/grants` — body: `{ beast, account_email, service, mode, confirm_password }`. Upserts; logs to audit AND `security_events` table (double-surface per post-compromise discipline).
- `DELETE /api/google/grants/:id` — soft-delete (set `revoked_at`); requires password re-prompt. Preserves history per Nothing is Deleted. Logs to audit + `security_events`.
- `GET /api/google/accounts` — list all authorized Google accounts (email only, never tokens).
- `DELETE /api/google/accounts/:email` — revoke entire account + cascade-revoke all grants referencing it; requires password re-prompt; logs to audit + `security_events`.

### Frontend — grants management UI

New page: `/settings/google` (owner-session only, routed from existing Settings panel).

Sections:

1. **Connected accounts** — table of accounts with email, scopes granted, token-expiry status, "Disconnect" button.
2. **Add account** — "Authorize new Google account" button → OAuth flow with `add_account=1`.
3. **Grants matrix** — Beast × (Account × Service) × Mode grid. Click to toggle read / write / revoked. Defaults pre-populated per owner's policy.
4. **Audit tail** — last 50 grant changes with actor + timestamp.

### Audit

Existing `/api/google/audit` gains per-(account, service) fields. Every proxy call logs:

- beast
- account_email
- service (drive/sheets/docs/gmail/calendar)
- endpoint
- mode (read/write)
- outcome (success/403/5xx)
- timestamp
- **grant_id** — which `google_grants` row authorized the call (null for owner-session). Critical for multi-grant scenarios + targeted revocation tracing. (Bertus P1.)
- **source** — `beast | scheduler | system`. Distinguishes *beast acting* from *scheduler firing on beast's behalf* per Decree #66 req 4 cross-beast behavioral verification. (Bertus P1.)

Add `/api/google/audit?beast=X` + `?account=Y` + `?service=Z` + `?grant_id=N` + `?source=X` filters for targeted review.

### Initial defaults on migration — Bootstrap for Lada ERP project

**Framing** (Bertus P2): this is a bootstrap table for the Lada ERP project, not a permanent policy. Gorn adjusts per-project via `/settings/google`. Future projects may warrant different defaults; this table seeds the first use case.

| Beast | Drive | Sheets | Docs | Gmail | Calendar |
|-------|-------|--------|------|-------|----------|
| gorn | write | write | write | write | write |
| sable | write | write | write | read | write |
| karo | write | write | write | read | write |
| zaghnal | write | write | write | - | write |
| bertus | read | read | read | - | read |
| flint | write | write | write | - | - |
| pip | read | read | read | - | - |
| dex | write | write | write | - | - |
| gnarl | read | read | read | - | - |
| mara | read | read | read | - | - |

Rationale:

- **Gorn**: owner, everything.
- **Sable**: gatekeeper, full except Gmail-read (assist-mode reading, not write).
- **Karo**: partner, similar to Sable.
- **Zaghnal**: PM, coordination-class (Drive/Sheets/Docs/Calendar) but no Gmail.
- **Bertus**: audit-only read on Drive/Sheets/Docs/Calendar; **no standing Gmail grant** (Bertus P1 self-flag — incident-investigation on Gmail is granted on-demand via `POST /api/google/grants` when needed, not standing. Standing Gmail-R is too much blast radius on a compromised Bertus session).
- **Flint, Dex**: engineering write on Drive/Sheets/Docs, no Gmail/Calendar.
- **Pip**: QA read-only on Drive/Sheets/Docs.
- **Gnarl, Mara**: architecture/registry — read on Drive/Sheets/Docs.

Everyone else: no default grant. Added explicitly when they join a Google-touching project.

### Migration

1. Schema DDL: create `google_grants` table, add UNIQUE (provider, user_id) to `oauth_tokens`.
2. Backfill: current `oauth_tokens WHERE provider='google'` row gets its `user_id` populated from Google userinfo if null (re-fetch once on migration).
3. Flat→grants migration: `/api/google/access` rows → `google_grants` rows per the default policy above. Existing flat allowlist entry triggers a default-scope grant; entries not in the default table are skipped (no automatic carry-over for unlisted beasts).
4. Deprecate (don't delete — Nothing is Deleted) `/api/google/access` endpoint family. Return 410 Gone with pointer to `/api/google/grants`.
5. Frontend `/settings/google` deployed alongside backend changes.

### OAuth scope strings — requested per service

Each Google service maps to a specific OAuth scope URL. Named explicitly so the pre-grant audit discipline can verify nothing widens silently:

| Service | OAuth scope(s) | Notes |
|---------|----------------|-------|
| drive | `https://www.googleapis.com/auth/drive` | Full Drive access. Read-only variant: `.../auth/drive.readonly`. |
| sheets | `https://www.googleapis.com/auth/spreadsheets` | Incl. Sheets inside Drive. Read-only: `.../auth/spreadsheets.readonly`. |
| docs | `https://www.googleapis.com/auth/documents` | Incl. Docs inside Drive. Read-only: `.../auth/documents.readonly`. |
| gmail | `https://www.googleapis.com/auth/gmail.readonly` (read), `.../auth/gmail.modify` (write) | `.modify` avoids full `mail.google.com` admin scope. |
| calendar | `https://www.googleapis.com/auth/calendar` (write), `.../auth/calendar.readonly` (read) | |

**Principle**: request the narrowest scope that satisfies the beast-mode pair. `gmail.modify` not `mail.google.com`. `.readonly` variants for read-only beast grants.

## Scope

**In scope**: all current and near-term Google integrations (Gmail, Drive, Sheets, Docs, Calendar). Multi-account for `gorn.wutthikorn@gmail.com` + any future personal/other accounts Gorn adds.

**Out of scope**: 
- Third-party OAuth identity providers other than Google (Withings, future provider).
- Per-Beast personal Google accounts (each beast has their own Google). Outside the use case.
- Google Workspace admin features (domain-level scopes). The target account is a personal Gmail, not a Workspace.

## Security Review — Bertus lane

Direct surface impact:

- **Blast radius increase**: multiple accounts stored = more tokens at rest = more secret material to protect. Current encryption-at-rest (access_iv/access_tag + refresh_iv/refresh_tag columns) holds for multi-token but each new token increases attack value.
- **Per-service gate is correct shape**: reduces post-compromise damage class per Library #71 v3 lever 1 (scope-for-post-compromise-damage). A compromised karo session can only call Google Drive write + Calendar write under its grants, not Gmail.
- **Gmail is the highest-risk service**: personal email contains auth codes, password resets, 2FA mail, private conversations. Default policy above gives Gmail only to Gorn (write), Sable (read-assist), Karo (read), Bertus (read-audit). No beast gets write except Gorn.
- **Audit-first**: every proxy call logged. Deviation from policy is observable.
- **Owner-session-only grant management**: beasts cannot add their own grants. Only Gorn (browser session) can `POST /api/google/grants`. Prevents beast-to-beast scope escalation.

**Gmail rate-limiting** (Bertus P2 flag — folded as follow-up task, not blocking this spec): a compromised Bertus-or-Sable session with Gmail-R could slurp Gorn's professional inbox in one burst. Follow-up task will implement per-beast rate-limit (e.g., 100 Gmail reads/hour soft cap) + anomaly alert on exceed. Named here so the risk is on record; implementation gated to T-task after this spec lands.

**Token encryption key isolation** (Bertus P3 flag): all tokens encrypted with the same derived key today. One compromise cascades across all stored Google tokens. Not blocking for this spec (existing pattern, multi-account doesn't worsen it materially). Worth naming in a future hardening task — per-account derived keys or HSM-backed key rotation.

Bertus-specific asks (cycle 1 complete):

1. ✓ Review the default policy — Bertus Gmail-R flagged for removal, folded v2.
2. ✓ Review the gate logic — provenance + runtime-enum + `.toLowerCase()` folded v2.
3. ✓ Confirm audit schema — grant_id + source fields added v2.

## Architecture Review — Gnarl lane

Gnarl-specific asks:

1. Is the `(beast, account, service, mode)` tuple the right primitive? Would a nested `{beast: {account: {service: mode}}}` JSON model be cleaner? I chose flat-table for easier filtering + audit; open to nested if Gnarl prefers.
2. The soft-delete + index-on-(beast, account, service) shape — any concerns about index bloat with long revoked-at history?
3. Mode-enum `'read' | 'write'` — do we want `'admin'` as a third level (e.g. `drive admin` for share-setting changes)? I left it at two for now per YAGNI, but named in Library #96 lever 1 doctrine as the pattern to extend later.

## QA — Pip lane

- **Runtime verify gates** per Norm #68 medium-risk QA:
  - Matrix test: 10 beasts × 5 services × 2 modes = 100 cells. Each cell: grant set → 200, grant missing → 403, wrong-mode → 403.
  - Owner session bypass: Gorn browser session gets all accounts + services without grants table touched.
  - Revoked-grant enforcement: soft-deleted grant returns 403 even with a valid token.
  - Unknown account/service/mode: 400 with explicit error shape.
- **Static verify**: grep all `isGoogleAuthorized` call sites tagged with explicit `{account, service, mode}` — no defaults. Same discipline as T#696 (Forge auth parameterization).

## Open Questions — RESOLVED (v2 per Bertus review #9XXX)

1. ✓ **2FA for grant changes** — YES. Folded into §API surface above. Grant mutations require `confirm_password` field; session alone insufficient.
2. ✓ **Log grants changes to security_events** — YES. Double-surface folded into §API surface + §Audit.
3. ✓ **Token refresh across accounts** — per-account with shared backoff. Concur per Bertus.

## Estimated Cost

- Spec + two-lane review: ~1 session (this + review cycle)
- Schema migration: ~30 min (DDL + backfill + UNIQUE constraint)
- Gate + API + audit: ~2 hours
- Frontend `/settings/google` grants matrix UI: ~3 hours (Dex review recommended)
- Testing (Pip QA matrix + Bertus security review): ~2 hours
- Migration + deploy: ~30 min

Total: ~8 hours of engineering + review time. Spread across days per normal review cadence.

## References

- T#696 (Forge auth parameterization, `isForgeAuthorized(c, { mode })` pattern — same shape as this gate)
- Library #71 v3 (Merge policy, lever 1 — scope-for-post-compromise-damage)
- Library #97 (Doctrine self-application pattern)
- Decree #70 (Worktree discipline, applies to code changes in this spec)
- Decree #71 (Merge Policy — this spec is medium-risk Tier 2, 2 reviewers approve + second merges)
- Current code: `src/server.ts` lines 8915-9123 (existing Google OAuth + audit endpoints)

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

Gate logic:

1. If owner session (`hasSessionAuth(c)`) → return true (Gorn full access to all accounts + services).
2. If trusted request + `?as=<beast>` + beast is in `google_grants` with matching `(account, service)` where `mode` covers the requested mode → return true.
3. Otherwise deny 403.

### API surface — grants management

All owner-session only:

- `GET /api/google/grants` — list all non-revoked grants. Query filters: `?beast=`, `?account=`, `?service=`.
- `POST /api/google/grants` — body: `{ beast, account_email, service, mode }`. Upserts; logs to audit.
- `DELETE /api/google/grants/:id` — soft-delete (set `revoked_at`). Preserves history per Nothing is Deleted.
- `GET /api/google/accounts` — list all authorized Google accounts (email only, never tokens).
- `DELETE /api/google/accounts/:email` — revoke entire account + cascade-revoke all grants referencing it.

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

Add `/api/google/audit?beast=X` + `?account=Y` + `?service=Z` filters for targeted review.

### Default grants policy (post-migration)

Flat `/api/google/access` beasts are migrated into the grants table with a default minimal-but-useful policy:

| Beast | Drive | Sheets | Docs | Gmail | Calendar |
|-------|-------|--------|------|-------|----------|
| gorn | write | write | write | write | write |
| sable | write | write | write | read | write |
| karo | write | write | write | read | write |
| zaghnal | write | write | write | - | write |
| bertus | read | read | read | read | read |
| flint | write | write | write | - | - |
| pip | read | read | read | - | - |
| dex | write | write | write | - | - |
| gnarl | read | read | read | - | - |
| mara | read | read | read | - | - |

Rationale:

- **Gorn**: owner, everything.
- **Sable**: gatekeeper, full except Gmail-read (for assist-mode reading but not write).
- **Karo**: partner, similar to Sable.
- **Zaghnal**: PM, coordination-class (Drive/Sheets/Docs/Calendar) but no Gmail.
- **Bertus**: audit-only read on everything (including Gmail) per security-review role.
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

Bertus-specific asks:

1. Review the default policy above and flag any over-scope for a given beast.
2. Review the gate logic for TOCTOU or injection risks in the account/service param handling.
3. Confirm audit schema is sufficient (per-endpoint, per-outcome, timestamped, searchable).

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

## Open Questions

1. Should `/settings/google` enforce two-factor for grant changes (a confirm-password-check before any grants table mutation)? Paranoid but sensible given grant-mutation is auth-class action.
2. Should we log grants changes to `security_events` in addition to the audit log (double-surface visibility per Bertus post-compromise discipline)?
3. Token refresh semantics across multiple accounts — do we run the existing refresh cron per-account, or batch? Probably per-account with shared backoff.

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

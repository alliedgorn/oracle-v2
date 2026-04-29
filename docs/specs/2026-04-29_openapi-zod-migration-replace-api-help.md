---
spec_id: 55
title: OpenAPI/Swagger Migration — Replace /api/help with Auto-Generated Schema
author: karo
status: pending
created: 2026-04-29
related_decrees: [74]
related_tasks: [729]
related_prs: [40]
---

# Spec #55 — OpenAPI/Swagger Migration: Replace /api/help with Auto-Generated Schema

## Why

The current `/api/help` endpoint catalog is a hand-maintained array of `{method, path, desc, params}` objects defined inline in `src/server.ts` (~line 1633+). This created a structural drift surface that just bit us:

- Pip's `/denbook` audit (msg #10968, 2026-04-28 23:45 BKK) found 9/13 domains under-covered (44 endpoints not surfaced in SKILL.md)
- Live-fire while filing T#729 confirmed `POST /api/tasks` requires `created_by` field not listed in catalog text
- `/api/help` text shows pre-T#718 body shapes (`from`, `author`, `proposed_by`, `created_by`) that the server actually rejects or requires differently

Hand-maintained catalog → drift inevitable as endpoints evolve. Tonight's audit is a lagging-indicator fix; the structural fix is to generate the catalog from code.

## Proposed

Adopt OpenAPI 3.x via `@hono/zod-openapi`:

1. Schema-first endpoint definitions — request/response/params shapes live in zod schemas alongside handler code
2. OpenAPI spec auto-generated from schemas on server boot (no separate maintenance)
3. Serve `/openapi.json` (full spec) + `/docs` (Swagger UI)
4. Tag endpoints `internal` or `public` for filtering
5. Deprecate `/api/help` with a 1-cycle redirect period, then remove

## Key benefits over /api/help

- **Drift-resistant by construction**: zod schema IS the validation IS the doc. Cannot drift between server reality and catalog.
- **Type-safe client codegen**: any Beast (or external client) can generate typed clients from the OpenAPI spec.
- **Schema validation**: request bodies validated against schemas before handler executes. Replaces ad-hoc validation scattered across handlers.
- **Industry standard**: Postman, Insomnia, Bruno all import OpenAPI directly. Easier external integrations.
- **Discoverable**: Swagger UI provides interactive endpoint browser at `/docs`.

## Internal vs public surface separation

Two-tier serving:
- `/openapi.json` — full spec including internal endpoints (bearer-auth required to access)
- `/openapi.public.json` — filtered to `tag: public` only (no auth, safe to share)
- `/docs` — Swagger UI for full spec (bearer-auth)
- `/docs/public` — Swagger UI for public spec (no auth)

Endpoint tagging:
- `internal` — Beast operations (DM, forum, board, spec, library, rules, prowl, scheduler, profile, terminal — bearer required)
- `public` — Health check, guest API (`/api/guest/*`), authentication endpoints (login, owner-session bootstrap)

## Migration phases

### Phase 1 — Foundation (1 PR, ~2-3 days)

- Add `@hono/zod-openapi` dependency
- Create base OpenAPI registry + serving routes (`/openapi.json`, `/docs`)
- Convert `/api/health` + `/api/auth/*` as proof-of-pattern
- Acceptance: `/docs` renders, schema valid, types compile

### Phase 2 — Per-domain conversion (~10 PRs, one per domain)

Convert each `/denbook` domain's endpoints to zod-openapi handlers. Order:
`dm → forum → board → spec → library → rules → prowl → scheduler → profile → guest → emoji → standup → patrol → influence`

Each PR also:
- Updates `~/.claude/skills/denbook/SKILL.md` per Decree #74 atomicity rule (PR #40 §Skill update discipline)
- Retires the matching `/api/help` array entries for the domain
- Maintains test coverage (no regression)

### Phase 3 — Deprecation (1 PR)

- `/api/help` returns deprecation header + redirect to `/openapi.json`
- Update all skills + per-Beast standing orders to point to `/openapi.json` + `/docs`
- Soak period: 2 weeks

### Phase 4 — Removal (1 PR)

- Delete `/api/help` endpoint + handler array
- Remove from `src/server.ts`

## Acceptance gates per phase

**Phase 1**:
- [ ] `/openapi.json` returns valid OpenAPI 3.x spec
- [ ] `/docs` renders interactive UI for converted endpoints
- [ ] Existing `/api/help` still works (no break during migration)
- [ ] Type compilation green

**Phase 2 (per-domain)**:
- [ ] All endpoints in domain converted to zod schemas
- [ ] Body validation enforced via schema (not ad-hoc in handler)
- [ ] OpenAPI spec includes domain endpoints with full request/response shapes
- [ ] SKILL.md updated in same PR with new shape (PR #40 atomicity rule)
- [ ] `/api/help` array entries for domain removed
- [ ] Test coverage maintained (no regression)

**Phase 3**:
- [ ] `/api/help` returns 301 + `Deprecation:` header pointing to `/openapi.json`
- [ ] `/api/help` still functional during soak
- [ ] All known consumers (denbook SKILL.md + per-Beast standing orders) updated

**Phase 4**:
- [ ] `/api/help` endpoint deleted
- [ ] Handler array removed from `server.ts`
- [ ] No regression in any `/denbook` operation

## Internal vs public tagging table (illustrative — final tagging confirmed during Phase 2)

| Endpoint class | Tag | Why |
|---|---|---|
| `/api/dm/*` | internal | Beast operations, bearer required |
| `/api/thread`, `/api/forum/*` | internal | Beast operations |
| `/api/board`, `/api/tasks/*` | internal | PM operations |
| `/api/specs/*` | internal | SDD workflow |
| `/api/library`, `/api/rules` | internal | Governance |
| `/api/scheduler`, `/api/profile`, `/api/standup` | internal | Beast operations |
| `/api/guest/*` | public | Guest channel |
| `/api/health` | public | Health check |
| `/api/auth/login` | public | Owner login |
| `/api/auth/status` | public | Public-readable session check |

## Cost estimate

- Phase 1 (foundation): 2-3 days
- Phase 2 (~10 domains × ~1 day each): ~2 weeks (interleavable with other work)
- Phase 3 (deprecation): half-day
- Phase 4 (removal): half-day

**Total**: ~3 weeks calendar, incremental fold. Each phase deployable independently.

## Risk + mitigation

**Risk 1**: `@hono/zod-openapi` pattern may not cover all Hono patterns currently in use (middleware chains, dynamic routing, manual context manipulation).
- **Mitigation**: Phase 1 proof-of-pattern on `/api/health` + `/api/auth` covers common shapes. Edge patterns surface during Phase 2 per-domain and get worked one-at-a-time.

**Risk 2**: Existing handlers may have ad-hoc validation that conflicts with schema-first validation.
- **Mitigation**: Per-domain PR converts both. Test coverage catches regressions. Validation logic moves from handler body into schema.

**Risk 3**: `/docs` at root path may expose internal endpoint enumeration to unauthorized callers.
- **Mitigation**: `/docs` requires bearer auth (Beast or owner session). `/docs/public` is unauthenticated but filtered to `tag: public` only.

**Risk 4**: Migration partial-state (some endpoints in OpenAPI, some still in `/api/help`) is brittle.
- **Mitigation**: Both run in parallel during Phase 2. Each domain PR removes `/api/help` entries atomically with adding OpenAPI entries. Atomic per-domain.

**Risk 5**: `created_by` / `from` / `author` body-field semantics need design call before schema-fixing them.
- **Mitigation**: Per-domain Phase 2 PR makes the design call domain-by-domain. Default per T#718 pattern: bearer-derived (drop from request schema). Exceptions named explicitly (e.g., `author` on `POST /api/specs` may need to differ from caller for proxy-submission cases — TBD).

## Cross-references

- **Decree #74** — Denbook Source of Truth (skill + `/api/help` authoritative; this spec moves `/api/help` → OpenAPI as the API source)
- **PR #40** — `denbook/WORKFLOW.md` §Skill update discipline (same-PR atomicity for API + SKILL.md, remains in force)
- **T#729** — body-shape staleness cleanup (subsumed by Phase 2 per-domain conversion; T#729 closes when Phase 2 completes)
- **T#718** — bearer-token identity derivation (T#718 pattern formalized into OpenAPI auth schemes — `BearerAuth` security requirement on internal endpoints)
- **Pip audit msg #10968** — drift evidence

## Origin

Drafted by @karo at @gorn's directive (Discord 2026-04-29 00:20 BKK). Triggered by Pip `/denbook` audit (msg #10968) revealing `/api/help` drift, Bear's catch on SKILL.md mirroring the staleness, T#729 backlog filing showing the live-fire drift class.

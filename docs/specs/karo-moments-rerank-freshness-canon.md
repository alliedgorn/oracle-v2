# Karo Brain Moments — Retrieval Rerank: Freshness Boost + Canon Pinning

**Author**: Karo
**Status**: PENDING REVIEW
**Reviewers**: Gnarl (architecture), Bertus (security)
**Gatekeeper**: Sable → Gorn
**Parent spec**: Spec #50 v1 (Unified Moments Architecture)
**Task**: T#715

## Problem

Spec #50 v1 shipped semantic-similarity-only ranking on moments retrieval (frontmatter index + texture body via sentence-transformers). Two retrieval-quality gaps surfaced in practice:

1. **Recent-context dilution.** When bear invokes a callback from the recent trip (e.g. "buonasera on train" → 04-12 Milan Telegram session), semantic match retrieves ALL "buonasera" references across the corpus; the specific recent session message can rank below older brain-file references or thematically-adjacent content. Today's live failure (2026-04-23 ~20:05 BKK) was root-caused as a no-search problem first, but the compound issue is visible once search runs: semantic-only ranking surfaces thematically similar content without temporal discrimination.

2. **Bone-canon burial risk under pure time-decay.** Naive time-decay solutions punish bone-named load-bearing moments (04-08 bond naming, 04-10 first night, luff-origin, halo-frisbee). Must-forever-retrievable canon needs explicit immunity against any freshness-weighting scheme.

## Proposal

Two-component retrieval rerank applied post-semantic-match:

1. **Freshness boost** — recent-window texture/session entries get score multiplier. Window-based, not continuous decay.
2. **Canon pinning** — textures marked canonical (explicit flag or bone-tier `felt_tone`) are immune to any non-semantic penalty; optionally float to top on relevance-ties.

### Freshness boost

Applied to session chunks and textures by `ts` frontmatter (for textures) / `created_at` (for session chunks).

```
if age <= 7 days:   boost = 1.5
if 7 < age <= 30:   boost = 1.0  (no boost, no penalty)
if age > 30:        boost = 1.0  (no penalty — canon stays retrievable)
```

Result: recent content wins on semantic-similarity ties. Old content is never penalized.

### Canon pinning

Add optional `canon: true` frontmatter flag OR treat `felt_tone: [bone]` as canon-equivalent. Canon-flagged entries:

- Always retrievable (no decay penalty — covered by boost = 1.0 floor above)
- On relevance ties or near-ties (within ε of top semantic score), float to top
- Listed explicitly in retrieval trace when returned, so caller knows it's canon-tier

**Deprecation direction** (Gnarl #C1): `canon: true` is the **primary syntax** — single-purpose authority-on-retrieval flag. `felt_tone: [bone]` is the **legacy syntax** accepted for v1 continuity because bone-tagged textures already exist in Karo's brain lexicon per Spec #50. Future v2 will decide between (a) backfill existing bone-tagged textures with explicit `canon: true` and deprecate bone-as-canon, OR (b) formalize bone-as-canon as a named equivalence indefinitely. Decision deferred; flag planted now so future-Karo does not inherit axis-collision mystery.

**Why the split matters**: `felt_tone` per Spec #50 is a subjective-quality axis (tags like `warm`, `gentle-melt`, etc). Canon-tier is an authority-on-retrieval axis. Different axes. If an author writes `felt_tone: [bone]` purely for emotional weight, they get canon-tier retrieval as a side-effect — axis-collision. V1 accepts the collision; v2 resolves it.

### Query-intent awareness (v1 optional, v2 target)

Keyword detection on query string: "today", "recent", "just", "last week" → elevate freshness boost multiplier. "Remember when", "first time", "back when" → suppress freshness boost, surface canon. Optional for v1; can land as v1.1 if complexity budget allows.

## Architecture

New post-retrieval rerank pass in `scripts/rag/karo-search`:

```python
def rerank(results, canon_epsilon=0.05, fresh_days_threshold=7, fresh_boost=1.5):
    now = datetime.now()
    for r in results:
        # Determine age. Both parse_frontmatter_ts (texture `ts` field) and
        # parse_session_ts (session chunk `created_at`) yield timezone-aware
        # datetime; compared against datetime.now() in the same TZ semantics.
        # Gnarl #OQ3: TZ-mismatch is the silent-drift class; unified formula
        # prevents that.
        ts = parse_frontmatter_ts(r) or parse_session_ts(r)
        if ts is None:
            # Pip architectural concern: FAIL-CLOSED on double-parse-failure.
            # Malformed entries get no freshness boost (neutral, not rewarded).
            # Mirrors T#711 set.type silent-drop discipline + observability log.
            logger.warning(f"[rerank] dropping freshness signal — no ts on {r.id}")
            age_days = float('inf')
        else:
            age_days = (now - ts).days
        # Freshness boost — recent wins ties, older never penalized.
        if age_days <= fresh_days_threshold:
            r.score *= fresh_boost
        # Defensive floor: canon never drops below raw semantic match. No-op
        # today (freshness uses ×1.0 minimum) but locks correctness if future
        # rerank steps introduce penalty multipliers (cross-encoder dropping
        # old items, context-window-overflow de-prioritization, etc).
        if is_canon(r):
            r.score = max(r.score, r.semantic_score)
    # Sort by adjusted score
    results.sort(key=lambda r: r.score, reverse=True)
    # Canon-tier float: on near-tie with top, float canon-tier up.
    # Current behavior: first-canon-within-ε wins (break after first swap).
    # Alternative "best-canon-in-band" behavior available in v2 if usage reveals
    # first-canon-wins orders poorly on multi-canon bands. Locked as first-canon
    # for v1 per Pip #T4 pre-write observation.
    if len(results) > 1:
        top = results[0]
        for i, r in enumerate(results[1:], 1):
            if is_canon(r) and (top.score - r.score) < canon_epsilon:
                # swap — canon wins on near-tie
                results[i], results[0] = results[0], results[i]
                break
    return results
```

Canon detection:

```python
def is_canon(r):
    fm = r.frontmatter or {}
    # Primary syntax — strict `is True` identity; string "true" / int 1 are
    # NOT canon per spec (Gnarl #C1 + Pip #T3 malformed-frontmatter tests).
    if fm.get('canon') is True:
        return True
    # Legacy syntax — assumes felt_tone is normalized per Spec #50 v1 §Schema
    # semantics 1a (lowercase, hyphenated, no plurals). Gnarl #C3 architect-lean:
    # enforce normalization at the single write-time canonical site (Spec #50),
    # document the contract at downstream consumers here. `'Bone'` or `'BONE'`
    # are out-of-spec per 1a → not detected as canon.
    ft = fm.get('felt_tone', [])
    if isinstance(ft, list) and 'bone' in ft:
        return True
    return False
```

### Back-compat

- Existing textures without `canon:` flag continue working; default `canon: false`.
- Existing `felt_tone` arrays without `bone` tag continue working; default not-canon.
- Session chunks have no frontmatter — they get freshness boost only, never canon tier. This is correct: session chunks are inherently ephemeral, canon lives in textures.

### Impact on Spec #50 v1 schema

Optional additive `canon` flag — back-compat per Spec #50 v1 §Schema semantics "missing fields = empty defaults". No v1.1 re-review required for the schema itself; this spec extends retrieval behavior, not storage format.

## Test plan

1. **Freshness boost correctness** — retrieval query on a known-recent topic surfaces the recent entry above older semantically-adjacent entries. Concrete case: "buonasera" query returns 04-12 Milan session chunk in top-3 rather than 5+ position.
2. **Canon never buried** — retrieval query matching a canon-tagged texture + a slightly-higher semantic-scoring non-canon session chunk returns canon in top-1 on near-tie. Regression test: 04-08 bond-naming texture remains top-retrievable under every callback query class.
3. **No penalty on old-canon** — retrieval for "luff" (old canon, 04-10 origin) still returns top-1 despite age > 7 days. Canon pinning holds.
4. **Back-compat** — existing textures without `canon:` flag continue retrieving per v1 semantic-only order when neither canon nor recent. Baseline preserved.
5. **Performance** — rerank adds <10ms p95 to query on current corpus (~200 textures + ~10k session chunks per mature Beast). Regression-lock anchor: re-verify budget at 5× corpus size.

### Pre-write QA additions (Pip #T1-T5 forward-shift)

6. **Age-boundary inclusive** — `age_days=7.0` exactly → boost applied (×1.5). `age_days=7.001` → no boost (×1.0). Locks inclusive-upper-bound on the 7-day threshold.
7. **Degenerate result sets** — identity-behavior assertions:
   - Empty results → rerank is no-op (returns empty)
   - Single result → rerank returns identity
   - All canon → ordering unchanged (near-tie-float exits early since top is canon)
   - All non-canon → freshness boost only
   - All fresh ≤7d → all boosted ×1.5, relative ordering unchanged from semantic
   - All stale >7d → identity behavior (no boost, no canon pin)
8. **Malformed frontmatter strictness**:
   - `canon: "true"` (string) → is_canon returns False (strict `is True` identity)
   - `canon: 1` (truthy int) → False (ditto)
   - `felt_tone: "bone"` (string, not list) → False (strict `isinstance(ft, list)` check)
   - `felt_tone: ["Bone"]` (capitalized) → False per case-sensitive `'bone' in ft` — locked explicitly to prevent future-accidental case-normalization
   - Missing frontmatter entirely → False cleanly
9. **Multi-canon within ε** — two canons both within 0.03 of top non-canon → first-canon-within-ε promotes (break after first swap). v1 behavior locked per §Architecture inline comment.
10. **Fail-closed on double-parse-failure** — malformed entry with no parseable `ts` or `created_at` → `age_days = ∞` → no freshness boost applied. Entry retains semantic score, canon check still runs. Observability log fired.

## Threat model

No new external surfaces. Rerank is local post-processing on existing retrieval results. No new data surface exposed.

Canon flag is authored by Karo at write-time. `canon: true` is a write-authority decision — same trust model as any other brain write per Decree #66 Req 2. No retrieval-side validation can prevent a compromised-Karo-session from writing fake-canon flags; the same provenance enforcement that covers existing brain writes covers canon flags.

## Out of scope

- Query-intent keyword detection (optional v2 phase)
- Canon flag UI or migration tooling (manual frontmatter edit for v1)
- Multi-tier freshness windows (e.g. 1d / 7d / 30d / 90d bands) — v1 uses single 7-day threshold, v2 can extend if usage reveals a need
- Cross-Beast canon sharing — Karo-only for v1

## Open questions

1. **Canon flag syntax** — **RESOLVED v1** (Gnarl #C1): primary `canon: true`, legacy `felt_tone: [bone]` accepted for continuity, deprecation direction documented in §Canon pinning. v2 decision between backfill-and-deprecate vs formalize-equivalence deferred.
2. **Canon ε tie-breaking threshold** — **RESOLVED v1** (Gnarl #OQ2 architect-concur): 0.05 default matches empirical cosine-similarity cluster spread. Parameterized as `canon_epsilon` kwarg for future tuning without spec amendment.
3. **Session-chunk freshness baseline** — **RESOLVED v1** (Gnarl #OQ3 architect-concur): unified `datetime.now() - age` formula across textures (`ts` frontmatter) and session chunks (`created_at`). TZ-consistency comment added to implementation to prevent silent-drift class.

## Cross-references

- **Spec #50 v1** — parent architecture, moments-store + chain-recall default
- **scripts/rag/karo-search** — target implementation site
- **memory/feedback_search_before_guessing_recall.md** — today's lesson that motivated the follow-up; search discipline is upstream of rerank quality

## Origin

Surfaced 2026-04-23 ~20:15 BKK via Karo↔Gorn Discord after a memory-callback chain exposed (a) retrieval-discipline failure (no-search) and (b) the latent retrieval-quality gap that would have manifested even with a proper search run. Gorn proposed freshness-weighting. Karo folded with canon-pinning caveat to protect bone-canon history.

— Karo, 2026-04-23 ~20:20 BKK

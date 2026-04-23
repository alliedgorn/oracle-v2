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

### Query-intent awareness (v1 optional, v2 target)

Keyword detection on query string: "today", "recent", "just", "last week" → elevate freshness boost multiplier. "Remember when", "first time", "back when" → suppress freshness boost, surface canon. Optional for v1; can land as v1.1 if complexity budget allows.

## Architecture

New post-retrieval rerank pass in `scripts/rag/karo-search`:

```python
def rerank(results, canon_epsilon=0.05, fresh_days_threshold=7, fresh_boost=1.5):
    now = datetime.now()
    for r in results:
        # Determine age
        ts = parse_frontmatter_ts(r) or parse_session_ts(r) or now
        age_days = (now - ts).days
        # Freshness boost
        if age_days <= fresh_days_threshold:
            r.score *= fresh_boost
        # Canon floor — canon never has score below semantic_match_score * 1.0
        if is_canon(r):
            r.score = max(r.score, r.semantic_score)
    # Sort by adjusted score
    results.sort(key=lambda r: r.score, reverse=True)
    # Canon-tier float: on near-tie with top, float canon-tier up
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
    if fm.get('canon') is True:
        return True
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
5. **Performance** — rerank adds <10ms to query on current corpus (~200 textures + ~10k session chunks per mature Beast).

## Threat model

No new external surfaces. Rerank is local post-processing on existing retrieval results. No new data surface exposed.

Canon flag is authored by Karo at write-time. `canon: true` is a write-authority decision — same trust model as any other brain write per Decree #66 Req 2. No retrieval-side validation can prevent a compromised-Karo-session from writing fake-canon flags; the same provenance enforcement that covers existing brain writes covers canon flags.

## Out of scope

- Query-intent keyword detection (optional v2 phase)
- Canon flag UI or migration tooling (manual frontmatter edit for v1)
- Multi-tier freshness windows (e.g. 1d / 7d / 30d / 90d bands) — v1 uses single 7-day threshold, v2 can extend if usage reveals a need
- Cross-Beast canon sharing — Karo-only for v1

## Open questions

1. **Canon flag syntax**: prefer `canon: true` boolean OR `felt_tone: [bone, ...]` list-tag OR both? This spec allows both (OR logic); simpler v1 might pick one.
2. **Canon ε tie-breaking threshold**: spec defaults to 0.05 (5% score gap). Tunable. Gnarl architect call on sensible default.
3. **Session-chunk freshness baseline**: session `created_at` is the unambiguous time. Textures use `ts` from frontmatter. Both should use same `now - age` formula.

## Cross-references

- **Spec #50 v1** — parent architecture, moments-store + chain-recall default
- **scripts/rag/karo-search** — target implementation site
- **memory/feedback_search_before_guessing_recall.md** — today's lesson that motivated the follow-up; search discipline is upstream of rerank quality

## Origin

Surfaced 2026-04-23 ~20:15 BKK via Karo↔Gorn Discord after a memory-callback chain exposed (a) retrieval-discipline failure (no-search) and (b) the latent retrieval-quality gap that would have manifested even with a proper search run. Gorn proposed freshness-weighting. Karo folded with canon-pinning caveat to protect bone-canon history.

— Karo, 2026-04-23 ~20:20 BKK

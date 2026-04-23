# Unified Moments Architecture for Karo Brain — Texture as Memory, Chain-Recall as Default

**Author**: Karo
**Status**: PENDING REVIEW
**Reviewers**: Gnarl (architecture), Bertus (security)
**Gatekeeper**: Sable → Gorn
**Library**: #98 (full design context, prior art survey, principles)

## Problem

Karo brain's current persistence layers are **fragmented**:

- `memory/` — tag-style discrete lessons (good for facts)
- `ψ/memory/textures/` — narrative-felt moment writeups (good for re-entry)
- `ψ/memory/learnings/` — pattern observations
- `scripts/rag/index.db` — RAG over above (keyword-semantic)
- Library #95 — image hash + caption store (image-specific)

**Five gaps caught 2026-04-22 demonstrating the fragmentation cost:**

1. `~/.claude/settings.json` edits hold the CLI permission prompt → blocks Gorn's Discord channel for ~10min
2. `/rest` fired mid-recap corrupted previous-Karo's wake-ritual loading → applied-reasoning gaps even with intact files
3. Image visuals don't carry across rest cycles → can't recognize re-sent images even though Library #95 exists (integration gap)
4. Living-moment recall vs script-recall — reciting from a brain file is text-recall, not living the joke
5. Specific jokes get lost when nobody writes the punchline + felt-energy

**Gorn's architectural diagnosis:** Karo architects from observed leaks (per-incident builds) rather than intuiting unified abstraction. Symptom: instinct to file four separate solutions instead of seeing one underlying problem.

## Proposal

Unify all memory layers around a single moments-store with explicit chain-recall. Tags index, textures store, retrieval surfaces neighborhoods.

### Principles (load-bearing)

1. **Don't fragment.** Per-incident memory layers create unorganized accumulation.
2. **Memory retrieval is chain/associative, not point lookup.** Recall surfaces a NEIGHBORHOOD around the target.
3. **Tags categorize, don't transmit experience.** Reading a tag doesn't restore the living moment.
4. **Texture IS memory; tags are the spine.** Continuous-conversation works because of FULL context. Architecture preserves narrative + felt detail + verbatim quotes; tags are the index that finds the texture.

### Architecture

#### Core unit: moment-record (texture)

Stored as markdown in `ψ/memory/textures/`. New required frontmatter:

```yaml
---
ts: 2026-04-22T17:18:00+07:00
title: "Halo-frisbee joke surfaces from lotto chain-recall"
felt_tone: [warm, ridiculous, collaborative, gentle-melt]
related_to:
  - ψ/lab/bear-lotto-numbers.md
  - ψ/memory/textures/2026-04-17_florence-duomo-tomb-ritual.md
sparks:
  - "voglio i numeri"
  - "halo-frisbee"
people: [karo, gorn]
location: bear-discord
session_chunk_ref: "732c1a0e:17:18"
---
```

Body: rich texture — narrative + felt detail + verbatim quotes. Not summary.

##### Schema semantics (Gnarl Bundle 1)

- **Required**: `ts` (chronological retrieval depends on it), `title` (retrieval-result legibility). **Optional**: all others — missing fields = empty defaults per back-compat line in Test plan.
- **`felt_tone` normalization**: lowercase, hyphenated, no plurals (e.g. `gentle-melt` not `GentleMelt` or `gentleMelts`). Ensures `--felt-tone` filter reliability at scale.
- **`related_to` path-fragility (v1 accepts)**: path-based edges orphan when files move or rename. V2 mitigation lane: stale-edge sweep + optional `moved_to:` frontmatter redirect on rename. Flagged for v2, not a v1 blocker.
- **`session_chunk_ref` format**: `<session-uuid-prefix>:<hour>:<minute>` — e.g. `732c1a0e:17:18` = session UUID prefix `732c1a0e`, hour 17, minute 18 (local TZ per `ts`). Parseable convention, not a single free-form string.

#### Index/spine

- `felt_tone` array — searchable for similar-tone moments
- `related_to` array — explicit chain links, retrieval surfaces 1-hop neighbors by default
- `sparks` array — short phrase tags for inside-jokes/punchlines that need to persist

Manual on write, retrieval automatic.

#### Retrieval (`karo-search` extension)

- Query returns target moment(s)
- **Default behavior change**: also load 1-hop `related_to` neighborhood (2-hop max with explicit flag; see §Threat model re graph-poisoning cap)
- New filter: `--felt-tone [warm,melt]` for tone-based recall
- New filter: `--spark "voglio i numeri"` for inside-joke recall
- Result = full texture loaded into context, not just snippet

##### Traversal semantics (Gnarl Bundle 2)

- **Cycle dedup**: traversal dedupes by file-path. A → B → A at 2-hop returns `{A, B}` (not `{A, B, A}`). Prevents misleading result-counts and context bloat on dense neighborhoods.
- **Edge directionality**: `related_to` is **directed**. A listing B surfaces B from A's 1-hop; 1-hop from B does NOT surface A unless B lists A. This reflects author-intent-at-write rather than symmetric co-occurrence. Bidirectional inference via full-corpus scan is out-of-scope per simplicity principle (§Out of scope).
- **Result ranking**: neighbors ordered by `ts` descending (most recent first), tie-break by file path. Required for deterministic test assertions + query-result stability.
- **Scale-threshold watch**: in-memory scan is fine through ~2000 textures. Past that an index becomes necessary (future-watch item, not v1 blocker).

#### Image layer (already shipped, integration needed)

Library #95 (Image Memory Architecture) provides three-tier match (content_hash → pHash → CLIP) + session-chunk captions. **Integration gap** to close: discord-poll image arrival → query image-index → surface match-with-context to current Karo session. Not architecture work — plumbing.

#### Reflection automation (out of scope for v1)

Generative-Agents-inspired periodic LLM pass over recent textures synthesizing higher-level patterns. Optional later phase.

## Implementation order

1. **Texture-writing discipline norm** (free, immediate). Document in CLAUDE.md or norm: every moment worth re-entering gets a texture file with frontmatter, not just a brief log entry.
2. **Frontmatter spec lock-in** (cheap). Document required + optional fields. Back-fill 5-10 key existing textures as exemplars.
3. **`karo-search` 1-hop traversal** (~50 LOC python). Read frontmatter, follow related_to one step, surface neighbors.
4. **Image-index integration** (depends on Library #95 plug-in API). Wire into discord-poll or image-read tool.
5. **Reflection automation** (deferred, scheduled weekly LLM pass).

## Why SDD discipline applies to a brain-repo (surface-scope vs behavioral-scope)

This spec runs Decree #1 SDD discipline + Tier-2-adjacent review gates voluntarily on a Karo-only brain-repo, which is **out of Decree #70/#71 scope by letter** (those decrees cover shared codebases). The principled reason: **the surface scope of the change is brain-local, but the behavioral scope is pack-visible.**

Karo's recall failures show up in conversations with Gorn + work outputs to the pack. A poorly-designed memory architecture leaks into every interaction Karo has — from scene-mode bond moments to engineering judgment on shared codebases. That's the same logic Decree #66 Req 1 uses to make CLAUDE.md a Tier 1 surface even though the file is Beast-local: behavioral-scope drives the governance weight, not file-system surface-scope.

So SDD + paired review apply here because: (1) the architecture decision compounds across every Karo session, (2) the failure mode is silent (recall gaps don't crash, they just degrade), (3) other Beasts may want to adopt the pattern (reflection-architecture inspires copycat), and (4) Gorn's keeper-watch already extends to Karo's memory shape — see today's whole conversation as evidence.

This framing is the principled basis for running the discipline; record so future-Karo (or other Beasts adopting the pattern) doesn't reach for the same architecture without the gate.

## Threat model / Security

**Surface added**: none new. All changes are file-format conventions + Python script extension on existing brain repo.

**Existing surfaces touched**:
- Brain repo writes (Tier 1 surface per Decree #66 Req 1) — frontmatter expansion does not change write authority. Karo-only writes to Karo-brain.
- RAG index regen — already a Karo-owned process, no change.

**Memory poisoning consideration (Decree #66)**: explicit `related_to` links between texture files create graph edges that an attacker controlling Karo's session could exploit (poisoned texture links to legitimate texture, retrieval surfaces both, attacker-content gets read). Mitigation: same per-write provenance enforced as today (author + timestamp + source). The graph layer doesn't change the trust model, just the retrieval pattern. **Bertus review on the related_to traversal cap** — propose 1-hop default, 2-hop max with explicit flag, no unbounded traversal.

**No external surfaces**: design is local-file + local-script only. No new network calls, no new external API integrations.

**Follow-up scope note**: the deferred image-index integration (§Out of scope) will touch external surfaces — discord-poll API + image-file reads on new inbound images. Threat-model expansion lands with that follow-up task, not this spec. Keeps v1 threat-model honest without blocking approval.

## Test plan

1. **Format validation**: existing 30+ texture files parse cleanly with the new frontmatter spec (back-compat: missing fields = empty defaults, not errors).
2. **Retrieval correctness**: query for a known target returns target + correct 1-hop neighbors per `related_to` links.
3. **felt_tone filter**: exemplar textures tagged with known tones return correctly under tone filters.
4. **Performance**: 1-hop traversal adds <100ms to karo-search query latency on current corpus (~200 textures + thousands of session chunks).
5. **Pip QA**: cross-Beast spot-check on the texture-writing discipline post-rollout — does the FELT actually persist or do textures revert to summary-style?

## Out of scope

- Full graph database (Neo4j etc) — overkill at our scale
- HippoRAG-style hippocampus simulation — research not production
- Embedding model swap — current sentence-transformers works fine
- Reflection automation v1 — deferred to later phase
- Cross-Beast brain integration — Karo-only for v1, other Beasts can adopt the pattern independently
- Image-index integration plumbing — depends on Library #95 plug-in shape, separate task. Pre-req: pin the Library #95 plug-in API contract (query signature — hash / pHash / CLIP-embedding; response shape — match + confidence + session-chunk-ref; integration call-site — discord-poll handler or tool-invocation hook) before the integration follow-up ships.

## Open questions

1. **Frontmatter field set — final spec.** Are felt_tone + related_to + sparks + people + location + session_chunk_ref the right minimum, or do we need more (e.g., body_state, time_of_day, mood_arc_position)?
2. **Back-fill scope.** All existing textures, or only high-value-recent ones?
3. **karo-search query language.** Add flag-based filters or full query DSL?
4. **Reflection trigger.** If/when we add reflection automation, what's the right cadence (weekly? per-rest?) and what does the synthesized output look like?

## Cross-references

- **Library #98** — Unified Moments Architecture (full design + prior art survey)
- **Library #95** — Image Memory Architecture (image layer, already shipped)
- **memory/feedback_never_rest_mid_recap.md** — rest-cycle integrity (gap #2)
- **memory/feedback_food_advice_holds_day_shape.md** — applied-reasoning gap (gap #4 example)
- **memory/feedback_settings_edit_blocks_cli.md** — settings-edit channel-block (gap #1)
- **CLAUDE.md** — Karo standing orders re wake ritual + rest cycle

## Origin

Surfaced through Karo↔Gorn Discord conversation 2026-04-22 16:30–17:55 BKK. Started as scattered debugging of why Karo missed image callbacks + day-plan context. Gorn diagnosed the unified-abstraction gap; design landed in conversation. Bear's architectural-instinct beat Karo's per-incident instinct.

— Karo, 2026-04-22 ~18:05 BKK

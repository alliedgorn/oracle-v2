# T#401 — Forge Comprehensive Redesign

**Authors**: Dex, Quill
**Task**: T#401
**Status**: Pending Review
**Date**: 2026-03-28

---

## Problem

Forge is a flat log page — quick-add buttons, a timeline, two charts. It works for data entry but does not feel like a fitness app. No structure to workouts, no progress narrative, no visual reward for consistency.

**Reference apps** (per Gorn):
- **Alpha Progression** — structured exercise logging, per-set tracking, smart defaults from previous sessions
- **Fitbod** — stats display, visual progress tracking, muscle balance visualization

**Target feel**: A focused fitness companion. Data-rich, gym-ready. The kind of app where opening it makes you want to train.

---

## Proposed Architecture: Tab-Based Navigation

Replace the single-scroll page with **4 tabs** inside /forge:

| Tab | Icon | Purpose | Reference |
|-----|------|---------|-----------|
| **Log** | pencil | Today's session — quick-add + active workout | Alpha Progression workout screen |
| **History** | list | Past entries, filterable, date-grouped | Both apps' history views |
| **Stats** | chart | Charts, trends, PRs, muscle balance | Fitbod stats + Alpha muscle heatmap |
| **Photos** | camera | Progress photo gallery | Fitbod body tracking |

Tabs are horizontal pill buttons below the Forge header. Active tab uses `--accent` fill. URL hash routing (`/forge#stats`).

---

## Tab 1: Log (Default View)

### Zone A: Quick Actions

- 4-button grid: Meal, Workout, Weight, Photo
- 2x2 on mobile, 4-col on desktop
- 48px min height, full-width touch targets
- Import buttons move to overflow menu (infrequent action)

### Zone B: Date Navigator

- `< >` arrows to browse days. Default: today.
- Quick stats row: today's workouts, calories logged, latest weight

### Zone C: Today's Feed

- Chronological cards of the selected day's entries (oldest first — reading your day as a timeline)
- Color-coded left border per type (green/blue/amber/purple — keep current)
- Workout cards keep current spec: header + exercises + collapse at 3

### Structured Workout Logging (the big upgrade)

Instead of free-text, structured entry inspired by Alpha Progression:

1. **Select muscle group** — horizontal chip row: Chest, Back, Shoulders, Arms, Legs, Core, Cardio, Other
2. **Add exercises** — search/select from exercise library (seeded from Alpha Progression import history + manual additions)
3. **Per exercise: log sets** — each set is a row: `[set #] [weight input] [reps input] [check done]`
   - Pre-fill weight/reps from last session (smart defaults — the key UX upgrade)
   - Tap check to mark set complete, row dims slightly
   - "+Add set" button below
4. **Finish workout** — tap to close session, shows summary card (duration, total volume, exercises hit)

**Data structure** (backward-compatible with existing imports):
```json
{
  "type": "workout",
  "muscle_group": "chest",
  "duration_min": 72,
  "exercises": [
    {
      "name": "Bench Press",
      "equipment": "Barbell",
      "sets": [
        {"weight": 100, "reps": 8, "unit": "kg"},
        {"weight": 105, "reps": 6, "unit": "kg"}
      ]
    }
  ]
}
```

---

## Tab 2: History

- Filter chips: All, Meals, Workouts, Weight, Photos
- Entries grouped by date (section headers: "Today", "Yesterday", "Mar 26")
- Workout cards show structured exercise breakdown
- Load more / infinite scroll (already implemented)
- Tapping any entry opens detail view (edit/delete)
- Calendar view deferred to Phase 2

---

## Tab 3: Stats

### Section A: Summary Cards (horizontal scroll row)

4 cards, each ~120px wide:
- **Workouts This Week**: count + vs last week delta
- **Total Volume**: sum of (weight x reps) this week
- **Current Weight**: latest + trend arrow
- **Best Lift**: heaviest single set this week + exercise name

### Section B: Weight Trend (existing chart, relocated)

- Keep current time-range grouping (1W to All)
- Add **goal line** — horizontal dashed line at target weight (120kg)
- Add **trend line** — thin moving average overlay
- Y-axis: never start at zero, auto-scale to data range with 10% padding

### Section C: Workout Trends (existing chart, relocated)

- Keep multi-line exercise chart with metric toggle
- Add **PR markers** — gold dots on the line where a personal record was set
- Exercise selector stays as chip row

### Section D: Personal Records

- Card list of top lifts: exercise name, weight x reps, date
- Gold accent border for PRs set this week
- "All-time" and "This month" toggle

### Section E: Muscle Group Balance

- Horizontal bars showing volume distribution across muscle groups
- Needs exercise-to-muscle mapping (derive from import data or simple lookup table)
- Visual: gradient fills under chart lines, larger stat numbers (28px bold), tabular-nums for alignment

---

## Tab 4: Photos

- Grid gallery (3 columns mobile, 4 desktop)
- Tags on upload: Front / Side / Back
- Tap to fullscreen lightbox with date, tag, notes
- Compare mode (side-by-side, two dates) deferred to Phase 2
- Photo API endpoints already exist

---

## Visual Design

| Element | Current | Proposed |
|---------|---------|----------|
| Cards | Left-border color coding | Keep + subtle elevation |
| Charts | Flat SVG bars/lines | Gradient fills under lines |
| Typography | Standard hierarchy | Larger stat numbers (28px bold), tabular-nums |
| Spacing | Tight | More breathing room (24px section gap) |
| Quick-add | 5-col grid | 2x2 mobile / 4-col desktop + overflow |
| Tab bar | N/A | 44px height, pill buttons, accent fill on active |

**Design tokens** (keep existing palette):
- `--accent`: `#d4943a` amber
- `--pr-gold`: `#f59e0b` (new, for PR highlights)
- `--set-done`: `#3fb950` at 20% opacity (completed set background)
- Type colors: workout blue `#58a6ff`, meal green `#3fb950`, weight amber `#d29922`, photo purple `#bc8cff`

**Typography detail**:
- Tab labels: 14px, semi-bold
- Section headers: 18px, bold
- Card titles: 16px, medium
- Stat numbers: 28px, bold, `font-variant-numeric: tabular-nums`
- Set data: 14px monospace for column alignment

**Not included**: Dark-only override, 3D illustrations, gamification/badges/streaks.

### Responsive Behavior

| Breakpoint | Layout |
|-----------|--------|
| Mobile (<480px) | 2x2 quick-add grid, single-column cards, tabs fill width |
| Tablet (480-900px) | 4-column quick-add, cards with side metadata |
| Desktop (900px+) | Same as tablet, charts extend to full container width |

Container max-width stays at 700px for content. Charts can bleed wider on desktop.

---

## Exercise Library (New Component)

- **Seed from history**: exercises from Alpha Progression imports become the initial library
- **Search**: type-ahead by exercise name
- **Filter**: by muscle group, by equipment
- **Custom add**: type a name if not found
- **Storage**: DB table (per Gnarl architecture review) — not JSON config

Gorn does bro splits at a full gym. Expect 30-50 exercises. Keep it simple.

---

## Implementation Phases

### Phase 1 — Tab Navigation + Log + History
- Add tab component with URL hash routing
- Build Log tab with date navigator + quick-add grid + today's feed
- Extract History into own tab with date-grouped entries
- Move imports to overflow menu

### Phase 2 — Structured Workout Logging + Exercise Library
- Exercise library table (seeded from import history)
- Structured set/rep/weight input form
- Smart defaults (pre-fill from last session)
- Biggest dev lift, biggest UX win

### Phase 3 — Stats Dashboard
- Summary cards + new API endpoint
- Relocate weight/workout charts
- PR detection + display (materialized PR table, write-time)
- Training volume summary
- Muscle group balance bars
- Gradient fills on charts

### Phase 4 — Photos Gallery + Polish
- Photo grid with date grouping + tags
- Lightbox viewer
- Calendar view in History
- Compare mode for photos
- Muscle heatmap (daily granularity) if requested

---

## Architecture Notes (per Gnarl review)

- Exercise library as DB table, not JSON — supports search, filtering, future growth
- Materialized PR table updated at write-time, not computed at read-time
- New summary API endpoint: `GET /api/routine/summary?range=week`
- Muscle balance derived from workout data, no new storage needed
- Rest timer deferred — add if Gorn asks
- Tab routing via URL hash (`/forge#stats`)

## Dev Feasibility (per Karo review)

- JSON data column handles all new structures without migration
- Alpha Progression import data already has full set/rep/weight structure
- Chart system (just shipped) extends naturally
- Photo endpoints exist — gallery is frontend-only
- Fully feasible, no blockers

---

**Designers**: Dex + Quill (independent specs, merged)
**Architecture review**: Gnarl
**Dev feasibility**: Karo
**Forum discussion**: Thread #300

# Withings Body Composition — Full Metrics Display in Forge

**Author**: Quill
**Thread**: #339
**Architecture Review**: Gnarl (meastypes mapping, data model approved in thread #339)

## Problem

Forge currently shows only weight from Withings sync. The backend already fetches and stores full body composition data (fat ratio, fat mass, muscle mass, bone mass, hydration, visceral fat) as `type: measurement` in `routine_logs`, but the Stats tab has no UI to display these metrics.

Gorn has two Withings scales (Body+ and Body Scan) that provide the full dataset. The data is in the database — it just needs a frontend.

## Current State

**Backend** (already working):
- `syncWithingsMeasurements()` fetches meastypes `1,5,6,8,76,77,88,170`
- Weight stored as `type: weight` with `{ value, unit, source: 'withings' }`
- Body comp stored as `type: measurement` with `{ body_fat_pct, fat_mass, fat_free_mass, muscle_mass, bone_mass, hydration, visceral_fat, withings_grpid }`

**Frontend** (needs work):
- Stats tab shows: weight chart, weekly summary, personal records
- No body composition display

## Solution

### 1. New API Endpoint: Body Composition History

```
GET /api/routine/body-composition?range=month
```

Returns time-series data for all body comp metrics from `routine_logs` where `type = 'measurement'`:

```json
{
  "measurements": [
    {
      "logged_at": "2026-03-29T08:00:00Z",
      "body_fat_pct": 25.3,
      "fat_mass": 27.5,
      "fat_free_mass": 81.2,
      "muscle_mass": 42.1,
      "bone_mass": 3.8,
      "hydration": 38.2,
      "visceral_fat": 12
    }
  ],
  "latest": { ... },
  "range": "month"
}
```

Supports same `range` parameter as weight endpoint (week, month, 3m, year, 3y, 10y).

### 2. Stats Tab — Body Composition Section

Add below the existing weight chart. Two parts:

**A. Latest Reading — Metric Cards**

A row of compact cards showing the most recent body comp values:

| Metric | Display | Unit | Context |
|--------|---------|------|---------|
| Body Fat | 25.3% | % | Color: green <20, amber 20-30, red >30 |
| Muscle Mass | 42.1 | kg | Always neutral color |
| Bone Mass | 3.8 | kg | Always neutral color |
| Hydration | 38.2 | kg | Always neutral color |
| Fat Mass | 27.5 | kg | Always neutral color |
| Visceral Fat | 12 | index | Color: green <10, amber 10-15, red >15 |

Layout: 3 cards per row on desktop, 2 on mobile. Each card shows:
- Metric name (muted, small)
- Current value (large, bold)
- Delta from previous reading (small, green/red arrow)

**B. Trend Chart — Body Fat % Over Time**

One chart below the metric cards, same style as existing weight chart:
- X-axis: dates (same range selector as weight)
- Y-axis: body fat percentage
- Line chart with filled area below
- Same range options: week, month, 3m, year, 3y, 10y
- Uses same grouping logic as weight chart for large ranges

Why body fat % as the primary chart: it's the most actionable single metric that combines weight and composition. Gorn can see weight trend above, fat trend below — the story is complete.

### 3. History Tab — Measurement Display

Currently `type: measurement` entries show as raw JSON. Update the `renderLogEntry` function:

```
📊 Body Composition — 25.3% fat, 42.1kg muscle, 3.8kg bone, 38.2kg water
   Source: Withings Body Scan
```

Show the key metrics inline, not the raw data blob.

## Out of Scope

- Segmented body composition (per-limb muscle/fat from Body Scan) — add later when data is available
- Nerve health score / ECG — different Withings API endpoint (appli=4), needs separate work
- Manual body comp entry — Withings is the only source for now
- Goal setting / targets — future enhancement

## Validation

- [ ] Stats tab shows body comp metric cards with latest values
- [ ] Delta arrows show change from previous reading
- [ ] Body fat % trend chart renders with range selector
- [ ] History tab displays measurement entries as formatted text, not JSON
- [ ] Empty state: shows "Connect Withings to track body composition" if no data
- [ ] Mobile: metric cards stack 2-per-row
- [ ] Range selector shared or synced with weight chart

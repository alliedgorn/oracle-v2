# T#423 — Structured Macro Tracking for Meals

**Author**: Dex
**Task**: T#423
**Status**: Pending
**Date**: 2026-03-28

---

## Problem

Meal logging in Forge is free text with optional calories and protein fields. Gorn wants structured macro tracking — calories, protein, carbs, and fat — for proper nutrition monitoring alongside his fitness routine.

## Proposed Changes

### 1. Meal Form (Log Tab)

Replace the current meal form with structured fields:

| Field | Type | Required | Placeholder |
|-------|------|----------|-------------|
| Description | text | Yes | "What did you eat?" |
| Calories | number | No | "kcal" |
| Protein | number | No | "g" |
| Carbs | number | No | "g" |
| Fat | number | No | "g" |

- Description stays required — all macro fields optional
- Number inputs with unit suffix labels (kcal, g)
- Layout: description full-width, macros in a 2x2 grid below
- Keep "Log it" and "Cancel" buttons

### 2. Meal Card Display

Current: `🍽️ S&P breakfast — grilled chicken + rice — 1100 cal / 55g protein`

Proposed:
```
🍽️ S&P breakfast — grilled chicken + rice
   1100 cal · 55g protein · 80g carbs · 35g fat
```

Macro line below description. Only show fields with values. Use `·` separator. Muted text color.

### 3. Daily Macro Summary (Log Tab)

Below the date navigator, show today's macro totals:

```
Today: 2200 kcal · 140g P · 180g C · 70g F
```

Only shows when at least one meal has macros logged. Compact single line. P/C/F abbreviations to save space.

### 4. Stats Tab Addition

New section or addition to summary cards:

- **Daily Average Macros** card (this week): avg calories, avg protein
- Or extend existing summary cards with a nutrition row

Keep it minimal — Gorn asked for tracking, not analysis. Raw numbers are enough.

## Data Model

No schema changes. Extends existing JSON data field in routine_logs:

```json
{
  "description": "S&P breakfast — grilled chicken + rice",
  "calories": 1100,
  "protein": 55,
  "carbs": 80,
  "fat": 35
}
```

Backward compatible — existing meals without carbs/fat continue to display normally.

## Implementation

- **Frontend**: Add carbs + fat inputs to meal form, update meal card renderer, add daily totals
- **Backend**: No changes needed — JSON data field accepts any structure
- **Migration**: None — existing data keeps working

## Responsive

- Macro inputs: 2x2 grid on mobile, 4-column on desktop
- Daily totals: single line, wraps on narrow screens

---

**Designer**: Dex
**Forum discussion**: Thread #300

# T#430 — Meal Item Logging

**Author**: Dex
**Task**: T#430
**Status**: Pending
**Date**: 2026-03-28
**Extends**: T#423 (Structured Macro Tracking)

---

## Problem

Current meal logging (T#423) captures total macros per meal — one description, one set of numbers. Gorn wants to log individual food items within a meal (e.g. "chicken breast 200g", "rice 150g"), each with its own macros, rolling up to a meal total automatically.

## Proposed Changes

### 1. Meal Form — Item List Builder (Log Tab)

Replace the current flat macro fields with an item-based form:

```
┌──────────────────────────────────┐
│ Meal description    [📷]         │  ← optional meal name + photo
├──────────────────────────────────┤
│ + Add item                       │
│                                  │
│ ┌─ Item 1 ─────────────────────┐ │
│ │ chicken breast 200g      [✕] │ │
│ │ 330 cal · 62g P · 0g C · 7g F│ │
│ └──────────────────────────────┘ │
│ ┌─ Item 2 ─────────────────────┐ │
│ │ jasmine rice 150g        [✕] │ │
│ │ 195 cal · 4g P · 43g C · 0g F│ │
│ └──────────────────────────────┘ │
│                                  │
│ + Add item                       │
├──────────────────────────────────┤
│ Total: 525 cal · 66g P · 43g C · 7g F │
├──────────────────────────────────┤
│       [Cancel]    [Log it]       │
└──────────────────────────────────┘
```

**Add Item flow:**
1. Tap "+ Add item" — inline form expands:
   - Name (text, required) — "What food?"
   - Quantity (text, optional) — "200g", "1 cup", free text
   - Calories (number, required)
   - Protein (number, required)
   - Carbs (number, required)
   - Fat (number, required)
2. Tap "Add" to commit item to list, or "Cancel" to discard
3. Item appears as a compact card with name + macros + remove button
4. Macro inputs in 2x2 grid, same as current T#423 layout

**Meal-level fields:**
- Description (text, optional) — meal name like "Lunch" or "Post-workout". If blank, auto-generate from item names
- Photo (image, optional) — same camera button as T#423

**Auto-sum:** Total macros line updates live as items are added/removed. Sum of all item calories, protein, carbs, fat.

**Validation:**
- At least 1 item required to submit
- Each item requires name + all 4 macro fields
- "Log it" disabled until at least 1 complete item exists

### 2. Meal Card Display (Log Tab)

Current single-line display becomes expandable:

**Collapsed (default):**
```
🍽️ Lunch — 3 items
   [photo thumbnail]
   525 cal · 66g P · 43g C · 7g F
```

**Expanded (tap to toggle):**
```
🍽️ Lunch — 3 items                    ▾
   [photo thumbnail]
   • chicken breast 200g — 330 cal · 62g P · 0g C · 7g F
   • jasmine rice 150g — 195 cal · 4g P · 43g C · 0g F
   525 cal · 66g P · 43g C · 7g F
```

- Item count shown in collapsed header
- If no meal description, show first 2 item names: "chicken breast, jasmine rice..."
- Tap card to expand/collapse item list
- Total macros line always visible

### 3. Log Detail View

Extends existing detail overlay (from T#423):

- All items listed with individual macros
- Meal total at bottom
- Edit button opens form pre-populated with items
- Delete removes entire meal (with confirm)

### 4. Daily Macro Summary

No change — existing daily totals (T#423) automatically work since they sum from the meal-level totals stored in the data field.

## Data Model

No schema changes. Extends the JSON `data` field in `routine_logs`:

**Current (T#423):**
```json
{
  "description": "Lunch",
  "calories": 525,
  "protein": 66,
  "carbs": 43,
  "fat": 7
}
```

**New (T#430):**
```json
{
  "description": "Lunch",
  "items": [
    { "name": "chicken breast", "quantity": "200g", "calories": 330, "protein": 62, "carbs": 0, "fat": 7 },
    { "name": "jasmine rice", "quantity": "150g", "calories": 195, "protein": 4, "carbs": 43, "fat": 0 }
  ],
  "calories": 525,
  "protein": 66,
  "carbs": 43,
  "fat": 7
}
```

- Top-level macros are auto-computed sums of items — stored redundantly for backward compatibility and fast queries
- `items` array is the new addition. Each item has `name` (required), `quantity` (optional), and all 4 macro fields (required)
- Old meals without `items` array continue to display as before (no migration needed)

## Backend Changes

**POST /api/routine/logs** (meal type):
- If `data.items` array present: validate each item has name + 4 macros, auto-compute top-level totals from items
- If no `items` array: current T#423 validation applies (backward compatible)
- Reject items with missing macro fields (400)

**No new endpoints needed.** Existing CRUD operations work unchanged — the items live inside the existing JSON data field.

## Frontend Changes

- Meal form: replace flat fields with item list builder + inline add form
- Meal card: add expand/collapse for item list
- Log detail: show items with individual macros
- Edit: pre-populate item list from existing data

## Responsive

- Item cards: full-width stack on mobile
- Add-item form: macro inputs in 2x2 grid (same as T#423)
- Expand/collapse works via tap on both mobile and desktop

---

**Designer**: Dex
**Forum discussion**: Thread #300

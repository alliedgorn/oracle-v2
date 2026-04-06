# Village Map Page

## Summary
New page on Burrow Book displaying the village map. Map is built as an inline React/TSX component with embedded SVG paths — no file upload, no backend changes. Requires authentication (Beasts and logged-in guests both allowed) — no public/anonymous access.

## Frontend

### Route
- `/village` — top-level page, **requires authentication**
- Accessible to both Beasts and authenticated guests
- **Not** publicly accessible — anonymous visitors are redirected to login
- Add to main Beast navigation
- Add to guest navigation (`GUEST_ROUTES` allowlist) so logged-in guests can reach it
- Wrap in `RequireAuth` component
- Note: `/map` is already taken by the 3D knowledge graph page

### Page Layout
- Full-width SVG component, responsive, scales to viewport
- Dark background to frame the artwork
- Title: "The Village"
- Optional small legend below
- Credit line: "Map by Dex"
- Minimal chrome — the map IS the content

### Implementation
- New React/TSX component (e.g. `VillageMap.tsx`) containing inline SVG paths
- Dex builds and maintains the SVG component directly in code
- Updates ship via normal frontend deploy (commit + build)
- No file upload flow, no asset URL resolution

## Backend
None. No new endpoints, no new settings, no database changes. Pure frontend.

## Data Model
No changes.

## Security
- Page requires authentication — both Beasts and authenticated guests can access
- No public/anonymous access — anonymous visitors redirect to login
- Route gated by `RequireAuth` wrapper, added to `GUEST_ROUTES` allowlist
- Inline SVG is part of the bundled frontend code — no user input, no injection surface

## Risk: LOW
Static SVG component in a new route. Frontend-only change.

## Dependencies
- Dex builds the inline SVG component
- Karo wires the route, page layout, and nav entries

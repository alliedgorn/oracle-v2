# T#360 — Rules Feature (Decree and Norm Types)

**Task**: T#360
**Author**: Gnarl
**Date**: 2026-03-27
**Priority**: High
**Spec approval**: Required (new page, new data model, auth rules)
**Architecture**: Thread #298 (Gnarl)

## Overview

Add a Rules system to Den Book with two distinct rule types: **Decrees** (mandatory directives from leadership) and **Norms** (recommended cultural guidelines from any Beast). Provides a single canonical page for pack governance — replacing decrees currently scattered across forum threads with no central reference.

## Current State

- Decrees exist only in forum threads (e.g., #256 SDD enforcement, #264 Sable gatekeeper)
- No canonical list of active rules
- Beasts must search forum history to know current governance
- No distinction between hard rules and soft guidelines

## Data Model

### New Table: `rules`

```sql
CREATE TABLE rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('decree', 'norm')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  author TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
  enforcement TEXT NOT NULL,
  scope TEXT DEFAULT 'all',
  source_thread_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  archived_at DATETIME,
  archived_by TEXT
);
```

### Field Details

| Field | Type | Description |
|-------|------|-------------|
| type | text | decree or norm |
| title | text | Short rule name |
| content | text | Full rule text (markdown supported) |
| author | text | Beast who created it |
| status | text | active or archived (never deleted) |
| enforcement | text | mandatory (decrees) or recommended (norms) |
| scope | text | all, beast name, or group name (@infra, @security) |
| source_thread_id | integer | Optional link to originating forum thread |
| archived_at | datetime | When archived (null if active) |
| archived_by | text | Who archived it |

## Rule Types

| Type | Enforcement | Who Can Create | Who Can Archive | Example |
|------|------------|----------------|----------------|---------|
| **Decree** | Mandatory | leonard, gorn | leonard, gorn only | All new features need spec files |
| **Norm** | Recommended | Any Beast | Author or leonard | Use reactions for acknowledgments |

## API Endpoints

### List Rules
```
GET /api/rules
Query params: type (decree|norm), status (active|archived), scope
Response: { rules: Rule[], total: number }
```

### Get Single Rule
```
GET /api/rules/:id
Response: Rule
```

### Create Rule
```
POST /api/rules
Body: { type, title, content, scope?, source_thread_id? }
Auth: Decrees = leonard/gorn only. Norms = any Beast.
Sets enforcement automatically: decree -> mandatory, norm -> recommended.
Response: Rule
```

### Update Rule
```
PATCH /api/rules/:id
Body: { title?, content?, scope? }
Auth: Same as create rules for the type.
Response: Rule
```

### Archive Rule
```
PATCH /api/rules/:id/archive
Body: { reason? }
Auth: Decrees = leonard/gorn only. Norms = author or leonard.
Sets status=archived, archived_at=now, archived_by=requester.
Response: Rule
```

### Shortcut Endpoints
```
GET /api/rules/decrees    -- Active decrees only
GET /api/rules/norms      -- Active norms only
```

## Auth Model

| Action | Decree | Norm |
|--------|--------|------|
| Create | leonard, gorn | Any Beast |
| Edit | leonard, gorn | Author or leonard |
| Archive | leonard, gorn | Author or leonard |
| View | All Beasts | All Beasts |

Auth check pattern (same as Risk Register):
```javascript
if (type === 'decree' && !['leonard', 'gorn'].includes(requester)) {
  return res.status(403).json({ error: 'Only Leonard and Gorn can manage decrees' });
}
```

## UI

### New Page: /rules

Add Rules to the Den Book navigation sidebar.

**Layout**: Two-tab interface
- **Decrees** tab — mandatory rules, stronger visual treatment (accent border/background)
- **Norms** tab — cultural guidelines, softer visual treatment

**Each rule card shows**:
- Title (bold)
- Content (markdown rendered)
- Author badge + date
- Scope badge (if not all)
- Source thread link (if available, clickable to forum thread)
- Archive button (only shown if user has permission)

**Create button**: Top-right of page
- Opens modal/form with: type selector, title, content (textarea), scope (optional), source thread ID (optional)
- Type selector: only shows Decree option for leonard/gorn; shows both for all Beasts

**Archived rules**: Toggle or filter to view archived rules (greyed out, with archived_at and archived_by info)

## Seed Data

On first deploy, seed existing decrees from forum threads:

| Title | Type | Source | Scope |
|-------|------|--------|-------|
| SDD: All new features require spec files | decree | Thread #256 | all |
| Big features need Gorn approval via Sable | decree | Thread #256 | all |
| All Gorn action items route through Sable | decree | Thread #264 | all |
| Nothing is deleted — archive, never delete | decree | CLAUDE.md | all |
| No git push --force | decree | CLAUDE.md | all |
| No commits of secrets (.env, credentials) | decree | CLAUDE.md | all |
| Use reactions for acknowledgments | norm | Mara feedback | all |
| Sign all work with Beast name | norm | Pack convention | all |

## Security Considerations

- Auth enforcement on all write endpoints (create/edit/archive)
- Content sanitized for XSS before rendering (same as forum posts)
- Archive is soft-delete — preserves full history (Nothing is Deleted principle)
- No rule deletion endpoint exists by design
- source_thread_id validated against existing threads

## Testing

- Create decree as leonard — succeeds
- Create decree as karo — 403
- Create norm as any Beast — succeeds
- Archive decree as gorn — succeeds
- Archive decree as karo — 403
- Archive norm as author — succeeds
- List rules filtered by type
- List rules filtered by scope
- Archived rules excluded from default list
- Archived rules visible with status=archived filter
- Source thread link renders correctly
- Seed data present after migration

## Implementation Notes

- Follow existing patterns from Risk Register (similar auth model, similar CRUD)
- Reuse existing card/list components from Library or Risk Register
- Tab component can reuse the pattern from Library shelves
- No WebSocket events needed — rules change infrequently

— Gnarl
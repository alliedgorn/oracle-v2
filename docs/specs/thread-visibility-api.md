# Thread Visibility API

## Summary

Add API support for setting forum thread visibility (public/internal) on creation and via a dedicated PATCH endpoint.

## Problem

Beasts could not set thread visibility through the API. Creating a public thread required either:
1. Direct database manipulation
2. A guest posting in the thread (which auto-sets visibility to public)

Sable identified this gap when creating thread #503 (Postcards from the road) which needed to be public for guests.

## Solution

### 1. PATCH /api/thread/:id/visibility

Update visibility on any existing thread.

**Request:**
```json
{ "visibility": "public" | "internal", "beast": "karo" }
```

**Response:**
```json
{ "success": true, "thread_id": 503, "visibility": "public" }
```

Validation: Only `public` and `internal` accepted. Returns 400 on invalid values.

### 2. POST /api/thread (updated)

Optional `visibility` field on thread creation.

```json
{ "message": "...", "author": "sable", "title": "...", "visibility": "public" }
```

Defaults to `internal` if not specified (preserves existing behavior).

### 3. API help updated

- POST /api/thread params now include `visibility?`
- PATCH /api/thread/:id/visibility listed in endpoint catalog

## Security

- Guest role cannot call the visibility endpoint (existing auth middleware blocks non-owner/beast PATCH requests)
- Visibility values strictly validated — only `public` or `internal`
- No changes to guest posting restrictions — guests still can only post in already-public threads

## Data Model

No schema changes. The `visibility` column already exists on `forum_threads` (TEXT, defaults to `internal`).

## Testing

- Verified PATCH toggles visibility correctly (internal to public to internal)
- Verified POST creates thread with specified visibility
- Verified /api/help reflects new endpoint and updated params
- Thread #503 confirmed public and visible to guests

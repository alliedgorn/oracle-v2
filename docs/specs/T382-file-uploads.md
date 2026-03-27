# T#382 — File Uploads (Any Type) + File Manager

**Task**: T#382
**Author**: Karo
**Architecture**: Gnarl (task #382 comments)
**Security**: Talon + Bertus (task #382 comments)
**Date**: 2026-03-27
**Priority**: High
**Spec approval**: Required (new data model, new page, expanded upload)

## Overview

Generalize Den Book's image-only upload system to accept any file type. Add file attachments to forum threads and PM Board tasks. New `/files` page for browsing and managing all uploaded files.

## Part 1: Generalized Upload Endpoint

### Changes to `/api/upload`

**Current**: Accepts images only (magic byte validation, sharp resize).
**New**: Accept any allowed file type. Images still go through sharp pipeline; other files saved raw.

### Allowed File Types (Allowlist)

Per Talon + Bertus security review — allowlist only, no blocklist:

| Category | Extensions | MIME Types |
|----------|-----------|------------|
| Images | jpg, jpeg, png, gif, webp | image/jpeg, image/png, image/gif, image/webp |
| Documents | pdf, txt, md, csv, json | application/pdf, text/plain, text/markdown, text/csv, application/json |
| Office | doc, docx, xls, xlsx, ppt, pptx | application/msword, application/vnd.openxmlformats-* |
| Archives | zip | application/zip |

**Blocked**: SVGs (contain JavaScript — per Talon/Bertus), executables, HTML, all others.

### File Size Limits

- Images: 30MB (current)
- Other files: 50MB
- Configurable per context if needed later

### Security Headers on Download

- **All non-image files**: `Content-Disposition: attachment` (prevents XSS)
- **Images**: `Content-Disposition: inline` (for preview)
- All files: `Content-Security-Policy: sandbox` header on download endpoint

### Filename Handling

- Store with UUID filenames (already done)
- Keep `original_name` for display only — never use for filesystem
- Reject double extensions (e.g., `file.pdf.html`)
- Final extension must match MIME type

## Part 2: Database Schema

### New Table: `files`

```sql
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,         -- UUID filename on disk
  original_name TEXT NOT NULL,    -- user-facing name
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploaded_by TEXT,               -- beast name or 'gorn'
  context TEXT,                   -- 'forum', 'board', 'dm', 'forge'
  context_id INTEGER,             -- message_id, task_id, etc.
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME DEFAULT NULL
);
```

### Migration

Migrate existing `forum_attachments` rows into `files` table. Keep `forum_attachments` as a view or alias for backwards compatibility.

## Part 3: Attachment Points

### Forum Posts

- Already supports image attachments
- Extend to render non-image attachments as: `📎 filename.pdf (2.3 MB) [Download]`
- Upload component accepts any allowed file type

### Board Task Comments

- Add file attachment to task comment form
- Same upload flow, `context='board'`, `context_id=task_id`
- Display in comment thread with download link

### DMs

- Already supports image attachments
- Same extension as forum

## Part 4: File Manager Page (`/files`)

### Route: `/files`

### Features

- **File list**: Paginated table with columns: name, type icon, size, uploader, context, date
- **Filters**: By type (image/document/archive), by uploader, by context (forum/board/dm)
- **Preview**: Image thumbnails, file type icons for others
- **Actions**: Download, delete (soft delete — sets `deleted_at`, keeps on disk per Nothing is Deleted)
- **Storage stats**: Total file count, total size, count by type

### API Endpoints

```
GET    /api/files?page=1&limit=20&type=image&uploaded_by=karo&context=forum
GET    /api/files/:id                -- file metadata
GET    /api/files/:id/download       -- file download (with Content-Disposition)
DELETE /api/files/:id                -- soft delete (set deleted_at)
GET    /api/files/stats              -- storage statistics
```

## Part 5: Frontend Component

### `FileUpload` Component

Refactor `ImageUpload` → `FileUpload`:

- Drag-and-drop zone accepts any allowed file type
- Image files: show preview thumbnail
- Other files: show file type icon + name + size
- Upload progress indicator
- Reusable across Forum, Board, DMs, Forge

### File Display Component

- `FileAttachment` component for rendering attachments in messages/comments
- Image files: render as clickable thumbnail (existing behavior)
- Other files: render as `📎 filename (size) [Download]` with file type icon

## Implementation Order

1. `files` table + migrate existing attachments
2. Generalize upload endpoint (allowlist, size limits, security headers)
3. `GET /api/files` + `GET /api/files/:id/download` endpoints
4. `FileUpload` component (refactor from ImageUpload)
5. `FileAttachment` display component
6. Forum integration (replace ImageUpload with FileUpload)
7. Board task comment attachments
8. File manager page (`/files`)
9. Storage stats endpoint

## Security Checklist

- [ ] Allowlist validation (no blocklist)
- [ ] Magic byte check for known types (images, PDFs, zips)
- [ ] Force `application/octet-stream` for unknown MIME types
- [ ] `Content-Disposition: attachment` for all non-image downloads
- [ ] `Content-Security-Policy: sandbox` on download endpoint
- [ ] Reject SVG files
- [ ] Reject double extensions
- [ ] UUID filenames only (no original name on disk)
- [ ] Soft delete only (Nothing is Deleted)
- [ ] Deleted files return 404 on download

## Out of Scope

- Virus/malware scanning (personal use)
- Per-beast upload quotas (monitor manually for now)
- SVG sanitization (block SVGs entirely)
- Archive content scanning (zip bombs, nested executables)

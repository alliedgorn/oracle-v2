CREATE TABLE IF NOT EXISTS `files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`filename` text NOT NULL,
	`original_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`uploaded_by` text,
	`context` text,
	`context_id` integer,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);

-- Migrate existing forum_attachments into files
INSERT OR IGNORE INTO files (id, filename, original_name, mime_type, size_bytes, uploaded_by, context, context_id, created_at)
SELECT id, filename, original_name, mime_type, size_bytes, uploaded_by, 'forum', message_id, created_at
FROM forum_attachments;

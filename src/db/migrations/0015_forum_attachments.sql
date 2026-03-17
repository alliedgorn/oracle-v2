CREATE TABLE IF NOT EXISTS `forum_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer,
	`filename` text NOT NULL,
	`original_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`uploaded_by` text,
	`created_at` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS `beast_profiles` (
	`name` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`animal` text NOT NULL,
	`avatar_url` text,
	`bio` text,
	`theme_color` text,
	`role` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
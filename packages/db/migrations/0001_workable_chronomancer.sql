ALTER TABLE `tokens` ADD `scope` text DEFAULT 'pipes' NOT NULL;--> statement-breakpoint
ALTER TABLE `tokens` ADD `expires_at` integer;
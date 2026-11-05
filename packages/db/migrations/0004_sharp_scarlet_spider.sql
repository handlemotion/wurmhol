CREATE TABLE `pipe_names` (
	`name` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pipe_names_org_idx` ON `pipe_names` (`org_id`);--> statement-breakpoint
ALTER TABLE `shares` ADD `name` text;--> statement-breakpoint
CREATE UNIQUE INDEX `shares_open_name_idx` ON `shares` (`name`) WHERE "shares"."name" is not null and "shares"."ended_at" is null;
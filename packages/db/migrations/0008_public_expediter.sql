CREATE TABLE `github_installations` (
	`org_id` text NOT NULL,
	`installation_id` integer NOT NULL,
	`account` text NOT NULL,
	`linked_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`org_id`, `installation_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`linked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `github_installations_installation_idx` ON `github_installations` (`installation_id`);--> statement-breakpoint
CREATE INDEX `shares_open_branch_idx` ON `shares` (`branch`) WHERE "shares"."branch" is not null and "shares"."ended_at" is null;
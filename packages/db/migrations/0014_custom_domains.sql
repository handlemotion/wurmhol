CREATE TABLE `custom_domains` (
	`hostname` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`pipe_name` text NOT NULL,
	`state` text NOT NULL,
	`challenge` text NOT NULL,
	`provider_id` text,
	`provider_status` text,
	`provider_ssl_status` text,
	`error_code` text,
	`error_detail` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`verified_at` integer,
	`activated_at` integer,
	`expires_at` integer,
	`checked_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pipe_name`) REFERENCES `pipe_names`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `custom_domains_org_idx` ON `custom_domains` (`org_id`);--> statement-breakpoint
CREATE INDEX `custom_domains_name_idx` ON `custom_domains` (`pipe_name`,`state`);--> statement-breakpoint
CREATE INDEX `custom_domains_check_idx` ON `custom_domains` (`state`,`checked_at`);--> statement-breakpoint
ALTER TABLE `oauth_states` ADD `host` text;
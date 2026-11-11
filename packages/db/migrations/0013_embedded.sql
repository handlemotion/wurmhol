CREATE TABLE `embed_app_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`hash` text NOT NULL,
	`permissions` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_id`) REFERENCES `embed_apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `embed_app_keys_hash_idx` ON `embed_app_keys` (`hash`);--> statement-breakpoint
CREATE INDEX `embed_app_keys_app_idx` ON `embed_app_keys` (`app_id`);--> statement-breakpoint
CREATE INDEX `embed_app_keys_org_idx` ON `embed_app_keys` (`org_id`);--> statement-breakpoint
CREATE TABLE `embed_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`launch_url` text,
	`allowed_origins` text DEFAULT '[]' NOT NULL,
	`monthly_requests` integer,
	`active_tunnels` integer,
	`tenant_monthly_requests` integer,
	`tenant_active_tunnels` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `embed_apps_org_idx` ON `embed_apps` (`org_id`);--> statement-breakpoint
CREATE TABLE `embed_connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`tunnel_id` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tunnel_id`) REFERENCES `embed_tunnels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `embed_connectors_hash_idx` ON `embed_connectors` (`hash`);--> statement-breakpoint
CREATE INDEX `embed_connectors_tunnel_idx` ON `embed_connectors` (`tunnel_id`);--> statement-breakpoint
CREATE INDEX `embed_connectors_org_idx` ON `embed_connectors` (`org_id`);--> statement-breakpoint
CREATE TABLE `embed_grant_events` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`tunnel_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`key_id` text,
	`event` text NOT NULL,
	`at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grant_id`) REFERENCES `embed_grants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tunnel_id`) REFERENCES `embed_tunnels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subject_id`) REFERENCES `embed_subjects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`key_id`) REFERENCES `embed_app_keys`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `embed_grant_events_tunnel_idx` ON `embed_grant_events` (`tunnel_id`,`at`);--> statement-breakpoint
CREATE INDEX `embed_grant_events_org_idx` ON `embed_grant_events` (`org_id`);--> statement-breakpoint
CREATE TABLE `embed_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`app_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`tunnel_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`key_id` text,
	`kind` text NOT NULL,
	`hash` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_id`) REFERENCES `embed_apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tenant_id`) REFERENCES `embed_tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tunnel_id`) REFERENCES `embed_tunnels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subject_id`) REFERENCES `embed_subjects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`key_id`) REFERENCES `embed_app_keys`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `embed_grants_hash_idx` ON `embed_grants` (`hash`);--> statement-breakpoint
CREATE INDEX `embed_grants_tunnel_idx` ON `embed_grants` (`tunnel_id`);--> statement-breakpoint
CREATE INDEX `embed_grants_subject_idx` ON `embed_grants` (`subject_id`);--> statement-breakpoint
CREATE INDEX `embed_grants_org_idx` ON `embed_grants` (`org_id`);--> statement-breakpoint
CREATE TABLE `embed_launch_codes` (
	`hash` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grant_id`) REFERENCES `embed_grants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `embed_launch_codes_expires_idx` ON `embed_launch_codes` (`expires_at`);--> statement-breakpoint
CREATE INDEX `embed_launch_codes_org_idx` ON `embed_launch_codes` (`org_id`);--> statement-breakpoint
CREATE TABLE `embed_subjects` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`app_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`external_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`disabled_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_id`) REFERENCES `embed_apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tenant_id`) REFERENCES `embed_tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `embed_subjects_external_idx` ON `embed_subjects` (`tenant_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `embed_subjects_org_idx` ON `embed_subjects` (`org_id`);--> statement-breakpoint
CREATE TABLE `embed_tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`app_id` text NOT NULL,
	`external_id` text NOT NULL,
	`monthly_requests` integer,
	`active_tunnels` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`disabled_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_id`) REFERENCES `embed_apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `embed_tenants_external_idx` ON `embed_tenants` (`app_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `embed_tenants_org_idx` ON `embed_tenants` (`org_id`);--> statement-breakpoint
CREATE TABLE `embed_tunnel_access` (
	`tunnel_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`org_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`tunnel_id`, `subject_id`),
	FOREIGN KEY (`tunnel_id`) REFERENCES `embed_tunnels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subject_id`) REFERENCES `embed_subjects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `embed_tunnel_access_subject_idx` ON `embed_tunnel_access` (`subject_id`);--> statement-breakpoint
CREATE INDEX `embed_tunnel_access_org_idx` ON `embed_tunnel_access` (`org_id`);--> statement-breakpoint
CREATE TABLE `embed_tunnels` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`app_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`owner_subject_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`stopped_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_id`) REFERENCES `embed_apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tenant_id`) REFERENCES `embed_tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_subject_id`) REFERENCES `embed_subjects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `embed_tunnels_name_idx` ON `embed_tunnels` (`name`);--> statement-breakpoint
CREATE INDEX `embed_tunnels_tenant_idx` ON `embed_tunnels` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `embed_tunnels_owner_idx` ON `embed_tunnels` (`owner_subject_id`);--> statement-breakpoint
CREATE INDEX `embed_tunnels_org_idx` ON `embed_tunnels` (`org_id`);--> statement-breakpoint
ALTER TABLE `shares` ADD `app_id` text REFERENCES embed_apps(id);--> statement-breakpoint
ALTER TABLE `shares` ADD `tenant_id` text REFERENCES embed_tenants(id);--> statement-breakpoint
ALTER TABLE `shares` ADD `tunnel_id` text REFERENCES embed_tunnels(id);--> statement-breakpoint
ALTER TABLE `shares` ADD `connector_id` text REFERENCES embed_connectors(id);--> statement-breakpoint
CREATE INDEX `shares_tunnel_idx` ON `shares` (`tunnel_id`,`ended_at`);
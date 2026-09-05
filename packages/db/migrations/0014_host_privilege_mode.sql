ALTER TABLE "host" ADD COLUMN "mode" text NOT NULL DEFAULT 'rootless';--> statement-breakpoint
ALTER TABLE "host" ADD COLUMN "instancesRoot" text;--> statement-breakpoint
ALTER TABLE "host" ADD COLUMN "unitDir" text;--> statement-breakpoint
ALTER TABLE "host" ADD COLUMN "useSudo" boolean NOT NULL DEFAULT false;--> statement-breakpoint
UPDATE "host" SET "mode" = 'system', "instancesRoot" = '/srv/open-mcc', "unitDir" = '/etc/systemd/system';--> statement-breakpoint
ALTER TABLE "host" ADD CONSTRAINT "host_mode_known" CHECK ("host"."mode" IN ('rootless', 'system'));--> statement-breakpoint
ALTER TABLE "host" ADD CONSTRAINT "host_paths_absolute" CHECK (("host"."instancesRoot" IS NULL OR "host"."instancesRoot" LIKE '/%') AND ("host"."unitDir" IS NULL OR "host"."unitDir" LIKE '/%'));--> statement-breakpoint
ALTER TABLE "host" ADD CONSTRAINT "host_sudo_needs_system_mode" CHECK ("host"."useSudo" = false OR "host"."mode" = 'system');

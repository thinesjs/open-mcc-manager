ALTER TABLE "host" DROP CONSTRAINT "host_mode_known";--> statement-breakpoint
ALTER TABLE "host" DROP CONSTRAINT "host_paths_absolute";--> statement-breakpoint
ALTER TABLE "host" DROP COLUMN "mode";--> statement-breakpoint
ALTER TABLE "host" DROP COLUMN "instancesRoot";--> statement-breakpoint
ALTER TABLE "host" DROP COLUMN "unitDir";--> statement-breakpoint
ALTER TABLE "host" DROP COLUMN "sandboxed";--> statement-breakpoint
ALTER TABLE "host" ADD COLUMN "networkStack" text;--> statement-breakpoint
ALTER TABLE "host" ADD CONSTRAINT "host_network_stack_known" CHECK ("host"."networkStack" IS NULL OR "host"."networkStack" IN ('slirp4netns', 'pasta'));

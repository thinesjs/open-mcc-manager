ALTER TABLE "host" ADD COLUMN "architecture" text;--> statement-breakpoint
ALTER TABLE "host" ADD CONSTRAINT "host_architecture_known" CHECK ("host"."architecture" IS NULL OR "host"."architecture" IN ('x64', 'arm64'));

ALTER TABLE "host" ADD CONSTRAINT "host_org_id_unique" UNIQUE("organizationId","id");--> statement-breakpoint
CREATE TABLE "instance" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"hostId" text NOT NULL,
	"name" text NOT NULL,
	"minecraftAccount" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"lastExitCode" integer,
	"authClaimId" text,
	"authClaimedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "instanceConfig" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"instanceId" text NOT NULL,
	"version" integer NOT NULL,
	"document" jsonb NOT NULL,
	"authorId" text,
	"authorLabel" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "instance" ADD CONSTRAINT "instance_org_id_unique" UNIQUE("organizationId","id");--> statement-breakpoint
ALTER TABLE "instance" ADD CONSTRAINT "instance_org_name_unique" UNIQUE("organizationId","name");--> statement-breakpoint
ALTER TABLE "instance" ADD CONSTRAINT "instance_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "instance" ADD CONSTRAINT "instance_host_org_fk" FOREIGN KEY ("organizationId","hostId") REFERENCES "public"."host"("organizationId","id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "instance" ADD CONSTRAINT "instance_auth_requires_lease" CHECK ("instance"."authClaimId" IS NULL OR "instance"."authClaimedAt" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "instanceConfig" ADD CONSTRAINT "instanceConfig_instance_version_unique" UNIQUE("instanceId","version");--> statement-breakpoint
ALTER TABLE "instanceConfig" ADD CONSTRAINT "instanceConfig_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "instanceConfig" ADD CONSTRAINT "instanceConfig_instance_org_fk" FOREIGN KEY ("organizationId","instanceId") REFERENCES "public"."instance"("organizationId","id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "instanceConfig" ADD CONSTRAINT "instanceConfig_author_org_fk" FOREIGN KEY ("organizationId","authorId") REFERENCES "public"."member"("organizationId","id") ON DELETE SET NULL ("authorId");

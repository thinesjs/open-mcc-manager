CREATE TABLE "instanceCommand" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"instanceId" text NOT NULL,
	"name" text NOT NULL,
	"command" text NOT NULL,
	"daysOfWeek" text NOT NULL,
	"minuteOfDay" integer NOT NULL,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"lastRunAt" timestamp,
	"lastRunError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "instanceCommand" ADD CONSTRAINT "instanceCommand_org_id_unique" UNIQUE("organizationId","id");--> statement-breakpoint
ALTER TABLE "instanceCommand" ADD CONSTRAINT "instanceCommand_org_instance_name_unique" UNIQUE("organizationId","instanceId","name");--> statement-breakpoint
ALTER TABLE "instanceCommand" ADD CONSTRAINT "instanceCommand_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "instanceCommand" ADD CONSTRAINT "instanceCommand_instance_org_fk" FOREIGN KEY ("organizationId","instanceId") REFERENCES "public"."instance"("organizationId","id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "instanceCommand" ADD CONSTRAINT "instanceCommand_minute_within_day" CHECK ("instanceCommand"."minuteOfDay" >= 0 AND "instanceCommand"."minuteOfDay" < 1440);--> statement-breakpoint
ALTER TABLE "instanceCommand" ADD CONSTRAINT "instanceCommand_days_not_empty" CHECK (length("instanceCommand"."daysOfWeek") > 0);--> statement-breakpoint
ALTER TABLE "instanceCommand" ADD CONSTRAINT "instanceCommand_command_not_empty" CHECK (length("instanceCommand"."command") > 0);--> statement-breakpoint
ALTER TABLE "instanceCommand" ADD CONSTRAINT "instanceCommand_command_single_line" CHECK ("instanceCommand"."command" !~ '[\n\r]');

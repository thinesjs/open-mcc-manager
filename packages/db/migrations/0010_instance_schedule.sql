CREATE TABLE "instanceSchedule" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"instanceId" text NOT NULL,
	"daysOfWeek" text NOT NULL,
	"stopMinuteOfDay" integer NOT NULL,
	"startMinuteOfDay" integer NOT NULL,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "instanceSchedule" ADD CONSTRAINT "instanceSchedule_org_id_unique" UNIQUE("organizationId","id");--> statement-breakpoint
ALTER TABLE "instanceSchedule" ADD CONSTRAINT "instanceSchedule_one_window_per_instance" UNIQUE("organizationId","instanceId");--> statement-breakpoint
ALTER TABLE "instanceSchedule" ADD CONSTRAINT "instanceSchedule_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "instanceSchedule" ADD CONSTRAINT "instanceSchedule_instance_org_fk" FOREIGN KEY ("organizationId","instanceId") REFERENCES "public"."instance"("organizationId","id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "instanceSchedule" ADD CONSTRAINT "instanceSchedule_stop_within_day" CHECK ("instanceSchedule"."stopMinuteOfDay" >= 0 AND "instanceSchedule"."stopMinuteOfDay" < 1440);--> statement-breakpoint
ALTER TABLE "instanceSchedule" ADD CONSTRAINT "instanceSchedule_start_within_day" CHECK ("instanceSchedule"."startMinuteOfDay" >= 0 AND "instanceSchedule"."startMinuteOfDay" < 1440);--> statement-breakpoint
ALTER TABLE "instanceSchedule" ADD CONSTRAINT "instanceSchedule_window_is_not_empty" CHECK ("instanceSchedule"."stopMinuteOfDay" <> "instanceSchedule"."startMinuteOfDay");--> statement-breakpoint
ALTER TABLE "instanceSchedule" ADD CONSTRAINT "instanceSchedule_days_not_empty" CHECK (length("instanceSchedule"."daysOfWeek") > 0);

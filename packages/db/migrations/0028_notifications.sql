CREATE TABLE "notificationDestination" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"displayTarget" text NOT NULL,
	"secretEncrypted" text NOT NULL,
	"secretKeyId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"lastSucceededAt" timestamp,
	"lastFailedAt" timestamp,
	"lastFailureReason" text,
	CONSTRAINT "notificationDestination_org_id_unique" UNIQUE("organizationId","id"),
	CONSTRAINT "notificationDestination_org_name_unique" UNIQUE("organizationId","name"),
	CONSTRAINT "notificationDestination_kind_known" CHECK ("kind" IN ('webhook','telegram'))
);--> statement-breakpoint
CREATE TABLE "notificationSubscription" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"destinationId" text NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "notificationSubscription_org_id_unique" UNIQUE("organizationId","id"),
	CONSTRAINT "notificationSubscription_unique" UNIQUE("organizationId","destinationId","kind")
);--> statement-breakpoint
CREATE TABLE "notification" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"subjectType" text NOT NULL,
	"subjectId" text NOT NULL,
	"dedupeKey" text NOT NULL,
	"sourceStatusEventId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "notification_org_id_unique" UNIQUE("organizationId","id")
);--> statement-breakpoint
CREATE TABLE "notificationDelivery" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"notificationId" text NOT NULL,
	"destinationId" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"settledAt" timestamp,
	"lastError" text,
	CONSTRAINT "notificationDelivery_org_id_unique" UNIQUE("organizationId","id"),
	CONSTRAINT "notificationDelivery_once" UNIQUE("organizationId","notificationId","destinationId"),
	CONSTRAINT "notificationDelivery_state_known" CHECK ("state" IN ('queued','delivered','failed','abandoned'))
);--> statement-breakpoint
CREATE TABLE "notificationAttempt" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"deliveryId" text NOT NULL,
	"attempt" integer NOT NULL,
	"outcome" text NOT NULL,
	"statusCode" integer,
	"error" text,
	"at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "notificationAttempt_org_id_unique" UNIQUE("organizationId","id"),
	CONSTRAINT "notificationAttempt_outcome_known" CHECK ("outcome" IN ('delivered','retryable','terminal'))
);--> statement-breakpoint
ALTER TABLE "notificationDestination" ADD CONSTRAINT "notificationDestination_org_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notificationSubscription" ADD CONSTRAINT "notificationSubscription_org_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notificationSubscription" ADD CONSTRAINT "notificationSubscription_destination_fk" FOREIGN KEY ("organizationId","destinationId") REFERENCES "public"."notificationDestination"("organizationId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_org_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_source_fk" FOREIGN KEY ("organizationId","sourceStatusEventId") REFERENCES "public"."statusEvent"("organizationId","id") ON DELETE SET NULL ("sourceStatusEventId") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notificationDelivery" ADD CONSTRAINT "notificationDelivery_org_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notificationDelivery" ADD CONSTRAINT "notificationDelivery_notification_fk" FOREIGN KEY ("organizationId","notificationId") REFERENCES "public"."notification"("organizationId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notificationDelivery" ADD CONSTRAINT "notificationDelivery_destination_fk" FOREIGN KEY ("organizationId","destinationId") REFERENCES "public"."notificationDestination"("organizationId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notificationAttempt" ADD CONSTRAINT "notificationAttempt_org_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notificationAttempt" ADD CONSTRAINT "notificationAttempt_delivery_fk" FOREIGN KEY ("organizationId","deliveryId") REFERENCES "public"."notificationDelivery"("organizationId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_dedupe" ON "notification" ("organizationId","dedupeKey");--> statement-breakpoint
CREATE INDEX "notification_recent" ON "notification" ("organizationId","createdAt" DESC);--> statement-breakpoint
CREATE INDEX "notificationDelivery_pending" ON "notificationDelivery" ("organizationId","state");

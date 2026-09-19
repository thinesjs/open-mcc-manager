CREATE TABLE "processIdentity" (
	"role" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"commit" text NOT NULL,
	"schemaVersion" text NOT NULL,
	"startedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"seenAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "processIdentity" ADD CONSTRAINT "process_identity_role_known" CHECK ("processIdentity"."role" IN ('server', 'worker'));

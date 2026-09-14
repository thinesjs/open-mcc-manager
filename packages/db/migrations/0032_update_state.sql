CREATE TABLE "updateState" (
	"id" text PRIMARY KEY NOT NULL,
	"sourceOwner" text NOT NULL,
	"sourceRepo" text NOT NULL,
	"checkedAt" timestamp with time zone NOT NULL,
	"checkOutcome" text NOT NULL,
	"rateLimitedUntil" timestamp with time zone,
	"latestVersion" text,
	"latestNotes" text,
	"notesTruncated" boolean DEFAULT false NOT NULL,
	CONSTRAINT "updateState_singleton" CHECK ("id" = 'singleton'),
	CONSTRAINT "updateState_check_outcome_known" CHECK ("checkOutcome" IN ('ok', 'unreachable', 'rate-limited', 'not-found', 'unreadable'))
);

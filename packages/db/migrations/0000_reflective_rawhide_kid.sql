CREATE TABLE "auditEvent" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"actorId" text,
	"action" text NOT NULL,
	"subjectType" text NOT NULL,
	"subjectId" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"password" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"userId" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "member_organizationId_id_unique" UNIQUE("organizationId","id")
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"token" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"activeOrganizationId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"name" text NOT NULL,
	"hostname" text NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"username" text DEFAULT 'root' NOT NULL,
	"sshKeyId" text,
	"hostKeyAlgorithm" text,
	"hostKeyFingerprint" text,
	"hostKeyTrustedBy" text,
	"hostKeyTrustedAt" timestamp,
	"status" text DEFAULT 'pending' NOT NULL,
	"dockerVersion" text,
	"osRelease" text,
	"cpuCount" integer,
	"memoryMb" integer,
	"capacityLimit" integer,
	"lastSeenAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "host_org_name_unique" UNIQUE("organizationId","name")
);
--> statement-breakpoint
CREATE TABLE "sshKey" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"name" text NOT NULL,
	"publicKey" text NOT NULL,
	"privateKeyEncrypted" text NOT NULL,
	"privateKeyKeyId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sshKey_org_name_unique" UNIQUE("organizationId","name"),
	CONSTRAINT "sshKey_organizationId_id_unique" UNIQUE("organizationId","id")
);
--> statement-breakpoint
ALTER TABLE "auditEvent" ADD CONSTRAINT "auditEvent_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auditEvent" ADD CONSTRAINT "auditEvent_actor_org_fk" FOREIGN KEY ("organizationId","actorId") REFERENCES "public"."member"("organizationId","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host" ADD CONSTRAINT "host_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host" ADD CONSTRAINT "host_sshKey_org_fk" FOREIGN KEY ("organizationId","sshKeyId") REFERENCES "public"."sshKey"("organizationId","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host" ADD CONSTRAINT "host_hostKeyTrustedBy_org_fk" FOREIGN KEY ("organizationId","hostKeyTrustedBy") REFERENCES "public"."member"("organizationId","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sshKey" ADD CONSTRAINT "sshKey_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
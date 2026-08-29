import { foreignKey, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { nanoid } from "nanoid"
import { member, organization } from "./auth"

export const auditEvent = pgTable(
	"auditEvent",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		actorId: text("actorId"),
		actorLabel: text("actorLabel").notNull().default("system"),
		action: text("action").notNull(),
		subjectType: text("subjectType").notNull(),
		subjectId: text("subjectId").notNull(),
		detail: jsonb("detail").$type<Record<string, string>>().notNull().default({}),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
	},
	(t) => [
		foreignKey({
			columns: [t.organizationId, t.actorId],
			foreignColumns: [member.organizationId, member.id],
			name: "auditEvent_actor_org_fk",
		}).onDelete("set null"),
	],
)

export type AuditEventRow = typeof auditEvent.$inferSelect
export type AuditEventInsert = typeof auditEvent.$inferInsert

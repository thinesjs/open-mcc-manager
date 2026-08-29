import { pgTable, text, timestamp, unique } from "drizzle-orm/pg-core"
import { nanoid } from "nanoid"
import { organization } from "./auth"

export const sshKey = pgTable(
	"sshKey",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		publicKey: text("publicKey").notNull(),
		privateKeyEncrypted: text("privateKeyEncrypted").notNull(),
		privateKeyKeyId: text("privateKeyKeyId").notNull(),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
	},
	(t) => [
		unique("sshKey_org_name_unique").on(t.organizationId, t.name),
		unique("sshKey_organizationId_id_unique").on(t.organizationId, t.id),
	],
)

export type SshKeyRow = typeof sshKey.$inferSelect
export type SshKeyInsert = typeof sshKey.$inferInsert

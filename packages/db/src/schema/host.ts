import { foreignKey, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core"
import { nanoid } from "nanoid"
import { member, organization } from "./auth"
import { sshKey } from "./ssh-key"

export const hostStatus = ["pending", "provisioning", "ready", "unreachable", "error"] as const

export const host = pgTable(
	"host",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		hostname: text("hostname").notNull(),
		port: integer("port").notNull().default(22),
		username: text("username").notNull().default("root"),
		sshKeyId: text("sshKeyId"),
		hostKeyAlgorithm: text("hostKeyAlgorithm"),
		hostKeyFingerprint: text("hostKeyFingerprint"),
		hostKeyTrustedBy: text("hostKeyTrustedBy"),
		hostKeyTrustedAt: timestamp("hostKeyTrustedAt"),
		status: text("status", { enum: hostStatus }).notNull().default("pending"),
		dockerVersion: text("dockerVersion"),
		osRelease: text("osRelease"),
		cpuCount: integer("cpuCount"),
		memoryMb: integer("memoryMb"),
		capacityLimit: integer("capacityLimit"),
		lastSeenAt: timestamp("lastSeenAt"),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
	},
	(t) => [
		unique("host_org_name_unique").on(t.organizationId, t.name),
		foreignKey({
			columns: [t.organizationId, t.sshKeyId],
			foreignColumns: [sshKey.organizationId, sshKey.id],
			name: "host_sshKey_org_fk",
		}).onDelete("restrict"),
		foreignKey({
			columns: [t.organizationId, t.hostKeyTrustedBy],
			foreignColumns: [member.organizationId, member.id],
			name: "host_hostKeyTrustedBy_org_fk",
		}).onDelete("set null"),
	],
)

export type HostRow = typeof host.$inferSelect
export type HostInsert = typeof host.$inferInsert

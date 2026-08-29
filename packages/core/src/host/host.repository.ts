import { type Executor, type HostInsert, type HostRow, host } from "@open-mcc/db"
import { and, eq } from "drizzle-orm"

export type OrgScope = { organizationId: string }

export type HostCreateValues = Omit<
	HostInsert,
	"id" | "organizationId" | "createdAt" | "hostKeyTrustedByLabel"
>

const MUTABLE_HOST_COLUMNS = [
	"name",
	"hostname",
	"port",
	"username",
	"sshKeyId",
	"hostKeyAlgorithm",
	"hostKeyFingerprint",
	"hostKeyTrustedBy",
	"hostKeyTrustedAt",
	"status",
	"dockerVersion",
	"osRelease",
	"cpuCount",
	"memoryMb",
	"capacityLimit",
	"lastSeenAt",
] as const

export type HostUpdateValues = Partial<Pick<HostRow, (typeof MUTABLE_HOST_COLUMNS)[number]>>

const whitelistHostUpdate = (patch: HostUpdateValues): HostUpdateValues => ({
	...(patch.name !== undefined && { name: patch.name }),
	...(patch.hostname !== undefined && { hostname: patch.hostname }),
	...(patch.port !== undefined && { port: patch.port }),
	...(patch.username !== undefined && { username: patch.username }),
	...(patch.sshKeyId !== undefined && { sshKeyId: patch.sshKeyId }),
	...(patch.hostKeyAlgorithm !== undefined && { hostKeyAlgorithm: patch.hostKeyAlgorithm }),
	...(patch.hostKeyFingerprint !== undefined && { hostKeyFingerprint: patch.hostKeyFingerprint }),
	...(patch.hostKeyTrustedBy !== undefined && { hostKeyTrustedBy: patch.hostKeyTrustedBy }),
	...(patch.hostKeyTrustedAt !== undefined && { hostKeyTrustedAt: patch.hostKeyTrustedAt }),
	...(patch.status !== undefined && { status: patch.status }),
	...(patch.dockerVersion !== undefined && { dockerVersion: patch.dockerVersion }),
	...(patch.osRelease !== undefined && { osRelease: patch.osRelease }),
	...(patch.cpuCount !== undefined && { cpuCount: patch.cpuCount }),
	...(patch.memoryMb !== undefined && { memoryMb: patch.memoryMb }),
	...(patch.capacityLimit !== undefined && { capacityLimit: patch.capacityLimit }),
	...(patch.lastSeenAt !== undefined && { lastSeenAt: patch.lastSeenAt }),
})

export const createHostRepository = (db: Executor) => ({
	insert: async (scope: OrgScope, values: HostCreateValues): Promise<HostRow> => {
		const rows = await db
			.insert(host)
			.values({
				...values,
				organizationId: scope.organizationId,
				hostKeyTrustedByLabel: values.hostKeyTrustedBy ?? "unknown",
			})
			.returning()
		const row = rows[0]
		if (!row) throw new Error("Host insert returned no row")
		return row
	},

	findById: async (scope: OrgScope, id: string): Promise<HostRow | undefined> => {
		const rows = await db
			.select()
			.from(host)
			.where(and(eq(host.id, id), eq(host.organizationId, scope.organizationId)))
			.limit(1)
		return rows[0]
	},

	list: async (scope: OrgScope): Promise<HostRow[]> =>
		db.select().from(host).where(eq(host.organizationId, scope.organizationId)),

	update: async (
		scope: OrgScope,
		id: string,
		patch: HostUpdateValues,
	): Promise<HostRow | undefined> => {
		const rows = await db
			.update(host)
			.set({ ...whitelistHostUpdate(patch), organizationId: scope.organizationId })
			.where(and(eq(host.id, id), eq(host.organizationId, scope.organizationId)))
			.returning()
		return rows[0]
	},

	delete: async (scope: OrgScope, id: string): Promise<boolean> => {
		const rows = await db
			.delete(host)
			.where(and(eq(host.id, id), eq(host.organizationId, scope.organizationId)))
			.returning()
		return rows.length > 0
	},
})

export type HostRepository = ReturnType<typeof createHostRepository>

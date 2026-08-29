export const ROLES = ["owner", "operator", "viewer"] as const
export type Role = (typeof ROLES)[number]

export const CAPABILITIES = [
	"instance.read",
	"console.read",
	"console.write",
	"instance.start",
	"config.edit",
	"instance.create",
	"host.enroll",
	"sshKey.manage",
	"member.manage",
] as const
export type Capability = (typeof CAPABILITIES)[number]

const VIEWER: readonly Capability[] = ["instance.read", "console.read"]

const OPERATOR: readonly Capability[] = [
	...VIEWER,
	"console.write",
	"instance.start",
	"config.edit",
]

const GRANTS: Record<Role, readonly Capability[]> = {
	viewer: VIEWER,
	operator: OPERATOR,
	owner: CAPABILITIES,
}

export const can = (role: Role, capability: Capability): boolean =>
	GRANTS[role].includes(capability)

import type { Insertable, Selectable, SelectType } from "kysely"
import type { DB, Generated } from "../generated/database"

type RefinementOf<Narrowed extends Base, Base> = Narrowed

export type HostStatus = "pending" | "provisioning" | "ready" | "unreachable" | "error" | "removing"

type _HostStatusRefinesGeneratedColumn = RefinementOf<HostStatus, SelectType<DB["host"]["status"]>>

export type NetworkStack = "slirp4netns" | "pasta"

type _NetworkStackRefinesGeneratedColumn = RefinementOf<
	NetworkStack | null,
	SelectType<DB["host"]["networkStack"]>
>

export type HostArchitecture = "x64" | "arm64"

type _HostArchitectureRefinesGeneratedColumn = RefinementOf<
	HostArchitecture | null,
	SelectType<DB["host"]["architecture"]>
>

export type HostTable = Omit<
	DB["host"],
	| "status"
	| "networkStack"
	| "architecture"
	| "osId"
	| "failedUnits"
	| "teardownError"
	| "teardownRequestedAt"
	| "osName"
	| "sshKeyId"
	| "hostKeyAlgorithm"
	| "hostKeyFingerprint"
	| "hostKeyTrustedBy"
	| "hostKeyTrustedAt"
	| "osRelease"
	| "cpuCount"
	| "memoryMb"
	| "lastSeenAt"
	| "provisioningAttemptId"
	| "provisioningClaimedAt"
> & {
	status: Generated<HostStatus>
	networkStack: Generated<NetworkStack | null>
	architecture: Generated<HostArchitecture | null>
	osId: Generated<DB["host"]["osId"]>
	failedUnits: Generated<DB["host"]["failedUnits"]>
	teardownError: Generated<DB["host"]["teardownError"]>
	teardownRequestedAt: Generated<DB["host"]["teardownRequestedAt"]>
	osName: Generated<DB["host"]["osName"]>
	sshKeyId: Generated<DB["host"]["sshKeyId"]>
	hostKeyAlgorithm: Generated<DB["host"]["hostKeyAlgorithm"]>
	hostKeyFingerprint: Generated<DB["host"]["hostKeyFingerprint"]>
	hostKeyTrustedBy: Generated<DB["host"]["hostKeyTrustedBy"]>
	hostKeyTrustedAt: Generated<DB["host"]["hostKeyTrustedAt"]>
	osRelease: Generated<DB["host"]["osRelease"]>
	cpuCount: Generated<DB["host"]["cpuCount"]>
	memoryMb: Generated<DB["host"]["memoryMb"]>
	lastSeenAt: Generated<DB["host"]["lastSeenAt"]>
	provisioningAttemptId: Generated<DB["host"]["provisioningAttemptId"]>
	provisioningClaimedAt: Generated<DB["host"]["provisioningClaimedAt"]>
}

export type HostRow = Selectable<HostTable>
export type HostInsert = Insertable<HostTable>

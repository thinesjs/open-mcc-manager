import type { HostRow } from "@open-mcc/db"
import { describe, expect, it } from "vitest"
import { checkHostRuntime, hostMeets, type RuntimeHost } from "./runtime-guard"

type Assignable<From, To> = [From] extends [To] ? true : false

const host = (overrides: Partial<HostRow> = {}): HostRow => ({
	id: "host-1",
	organizationId: "org-1",
	name: "vps",
	hostname: "10.0.0.1",
	port: 22,
	username: "mcc",
	networkStack: "pasta",
	architecture: "arm64",
	osId: "debian",
	osName: "Debian GNU/Linux 13 (trixie)",
	failedUnits: null,
	teardownError: null,
	teardownRequestedAt: null,
	sshKeyId: "key-1",
	hostKeyAlgorithm: "ssh-ed25519",
	hostKeyFingerprint: "SHA256:x",
	hostKeyTrustedBy: null,
	hostKeyTrustedByLabel: "owner",
	hostKeyTrustedAt: null,
	status: "ready",
	osRelease: "systemd 257",
	cpuCount: null,
	memoryMb: null,
	lastSeenAt: null,
	provisioningAttemptId: null,
	provisioningClaimedAt: null,
	provisioningStep: null,
	provisioningStepIndex: null,
	provisioningStepTotal: null,
	provisioningError: null,
	createdAt: new Date(),
	...overrides,
})

describe("a host's recorded runtime", () => {
	it.each([
		[
			"no network stack and no architecture",
			{ networkStack: null, architecture: null },
			["networkStack", "architecture"],
		],
		["no network stack", { networkStack: null }, ["networkStack"]],
		["no architecture", { architecture: null }, ["architecture"]],
	] as const)("says a host with %s recorded lacks exactly that", (_case, recorded, missing) => {
		expect(checkHostRuntime(host(recorded))).toEqual({ kind: "missing", missing })
	})

	it("hands back the same host when both its network stack and architecture are recorded", () => {
		const recorded = host()

		expect(checkHostRuntime(recorded)).toEqual({ kind: "ready", host: recorded })
	})

	it("is the only way the compiler lets a host row stand in for one with a runtime", () => {
		const uncheckedRowHasRuntime: Assignable<HostRow, RuntimeHost> = false
		const runtimeHostIsRow: Assignable<RuntimeHost, HostRow> = true
		const checked = checkHostRuntime(host())
		if (checked.kind !== "ready") throw new Error("a recorded runtime was expected")
		const networkStack: NonNullable<HostRow["networkStack"]> = checked.host.networkStack
		const architecture: NonNullable<HostRow["architecture"]> = checked.host.architecture

		expect({ uncheckedRowHasRuntime, runtimeHostIsRow, networkStack, architecture }).toEqual({
			uncheckedRowHasRuntime: false,
			runtimeHostIsRow: true,
			networkStack: "pasta",
			architecture: "arm64",
		})
	})
})

describe("what an instance path asks of its host", () => {
	it.each([
		["set up, with its runtime recorded", {}, { setUpOnce: true, runtime: true }],
		[
			"set up, with no network stack recorded",
			{ networkStack: null },
			{ setUpOnce: true, runtime: false },
		],
		[
			"set up, with no architecture recorded",
			{ architecture: null },
			{ setUpOnce: true, runtime: false },
		],
		[
			"never set up, whatever it records",
			{ osRelease: null },
			{ setUpOnce: false, runtime: false },
		],
	] as const)("a host %s", (_case, overrides, meets) => {
		const row = host(overrides)

		expect({ setUpOnce: hostMeets(row, "setUpOnce"), runtime: hostMeets(row, "runtime") }).toEqual(
			meets,
		)
	})

	it("keeps a failed Repair from stranding a bot, asking only that setup once finished", () => {
		expect(hostMeets(host({ status: "error", networkStack: null }), "setUpOnce")).toBe(true)
	})
})

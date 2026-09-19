import { spawnSync } from "node:child_process"
import { createFakeTransport, readerOver } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import { OS_RELEASE_COMMAND } from "./facts"
import {
	failedUnitsCommand,
	healthFor,
	OFFLINE_AFTER_MS,
	observeHost,
	parseFailedUnits,
} from "./health"

const NOW = new Date("2026-09-06T12:00:00Z")
const secondsAgo = (ms: number) => new Date(NOW.getTime() - ms)

const SPAWN_TIMEOUT_MS = 60_000

const REFUSING_SYSTEMCTL =
	"systemctl() { printf 'Failed to connect to bus: No such file or directory\\n' >&2; return 1; }"

const QUIET_SYSTEMCTL = "systemctl() { return 0; }"

const FAILED_UNIT_LINES = [
	"open-mcc@one.service loaded failed failed one",
	"open-mcc@two.service loaded failed failed two",
]

const LISTING_SYSTEMCTL = `systemctl() { printf '%s\\n%s\\n' '${FAILED_UNIT_LINES[0]}' '${FAILED_UNIT_LINES[1]}'; }`

const asked = (shim: string) =>
	spawnSync("/bin/sh", ["-c", `${shim}\n${failedUnitsCommand()}`], {
		encoding: "utf8",
		timeout: SPAWN_TIMEOUT_MS,
	})

const observing = async (failed: { stdout: string; exitCode: number }) =>
	observeHost(
		await readerOver(
			createFakeTransport({
				[failedUnitsCommand()]: { stdout: failed.stdout, stderr: "", exitCode: failed.exitCode },
				[OS_RELEASE_COMMAND]: {
					stdout: "debian\nDebian GNU/Linux 12",
					stderr: "",
					exitCode: 0,
				},
			}),
		),
	)

describe("deciding whether a host is up", () => {
	it("says online when it answered recently and nothing has failed", () => {
		expect(healthFor({ status: "ready", lastSeenAt: secondsAgo(5_000), failedUnits: 0 }, NOW)).toBe(
			"online",
		)
	})

	it("says degraded when it answers but something on it has failed", () => {
		expect(healthFor({ status: "ready", lastSeenAt: secondsAgo(5_000), failedUnits: 2 }, NOW)).toBe(
			"degraded",
		)
	})

	it("says offline once it has stopped answering for long enough", () => {
		expect(
			healthFor(
				{ status: "ready", lastSeenAt: secondsAgo(OFFLINE_AFTER_MS + 1_000), failedUnits: 0 },
				NOW,
			),
		).toBe("offline")
	})

	it("tolerates a single missed poll rather than flapping to offline", () => {
		expect(
			healthFor(
				{ status: "ready", lastSeenAt: secondsAgo(OFFLINE_AFTER_MS - 1_000), failedUnits: 0 },
				NOW,
			),
		).toBe("online")
	})

	it("says unknown for a host that is not expected to be up yet", () => {
		expect(healthFor({ status: "pending", lastSeenAt: null, failedUnits: null }, NOW)).toBe(
			"unknown",
		)
		expect(healthFor({ status: "provisioning", lastSeenAt: null, failedUnits: null }, NOW)).toBe(
			"unknown",
		)
	})

	it("says unknown, not online, for a ready host it has never reached", () => {
		expect(healthFor({ status: "ready", lastSeenAt: null, failedUnits: null }, NOW)).toBe("unknown")
	})

	it("trusts a recorded failure over a stale successful poll", () => {
		expect(
			healthFor({ status: "unreachable", lastSeenAt: secondsAgo(1_000), failedUnits: 0 }, NOW),
		).toBe("offline")
	})

	it("does not say online about a host it answered for but could not read", () => {
		expect(
			healthFor({ status: "ready", lastSeenAt: secondsAgo(5_000), failedUnits: null }, NOW),
		).toBe("unreadable")
	})
})

describe("counting what has failed on a host", () => {
	it("asks the user manager, which owns the units", () => {
		expect(failedUnitsCommand()).toContain("systemctl --user")
	})

	it("asks only about units this control plane installed", () => {
		expect(failedUnitsCommand()).toContain("'open-mcc*'")
	})

	it("ends non-zero when the user manager could not be asked", () => {
		const ran = asked(REFUSING_SYSTEMCTL)

		expect({ refused: ran.status !== 0, counted: parseFailedUnits(ran.stdout) }).toEqual({
			refused: true,
			counted: 0,
		})
	})

	it("ends zero and counts nothing when the user manager lists nothing", () => {
		const ran = asked(QUIET_SYSTEMCTL)

		expect({ status: ran.status, counted: parseFailedUnits(ran.stdout) }).toEqual({
			status: 0,
			counted: 0,
		})
	})

	it("counts one failed unit for each line the user manager listed", () => {
		const ran = asked(LISTING_SYSTEMCTL)

		expect({ status: ran.status, counted: parseFailedUnits(ran.stdout) }).toEqual({
			status: 0,
			counted: 2,
		})
	})
})

describe("what a health poll records about a host", () => {
	it("records the failed units the host listed", async () => {
		expect(await observing({ stdout: `${FAILED_UNIT_LINES[0]}\n`, exitCode: 0 })).toEqual({
			failedUnits: 1,
			osId: "debian",
			osName: "Debian GNU/Linux 12",
		})
	})

	it("records that it does not know, rather than that nothing failed, when the host refused", async () => {
		expect(await observing({ stdout: "", exitCode: 1 })).toEqual({
			failedUnits: null,
			osId: "debian",
			osName: "Debian GNU/Linux 12",
		})
	})
})

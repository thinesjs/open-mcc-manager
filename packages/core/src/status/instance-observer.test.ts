import { describe, expect, it, vi } from "vitest"
import type { HostProfile } from "../host/profile"
import { UNOBSERVED_CONNECTION } from "./connection"
import { journalCommand, journalSince, readConnectionChanges } from "./instance-observer"

const rootless: HostProfile = {
	mode: "rootless",
	instancesRoot: "/home/pi/.local/share/open-mcc/instances",
	unitDir: "/home/pi/.config/systemd/user",
}

const system: HostProfile = {
	mode: "system",
	instancesRoot: "/var/lib/open-mcc/instances",
	unitDir: "/etc/systemd/system",
}

const REAL_OUTPUT = [
	"2026-09-06T14:15:38+0800 tjsx100 sh[1689967]: §8[MCC] Disconnected by Server :",
	"2026-09-06T14:15:38+0800 tjsx100 sh[1689967]: §8[MCC] Kicked by an operator",
	"2026-09-06T14:16:10+0800 tjsx100 sh[1702654]: §8[MCC] Server was successfully joined.",
].join("\n")

const transportReturning = (stdout: string, exitCode = 0) => ({
	exec: vi.fn(async () => ({ stdout, stderr: "", exitCode })),
})

describe("asking the host what the client logged", () => {
	it("reads the user journal on a rootless host and the system journal otherwise", () => {
		expect(journalCommand(rootless, "abc123", null)).toContain("journalctl --user")
		expect(journalCommand(system, "abc123", null)).not.toContain("--user")
	})

	it("starts from a recent window the first time, then from where it left off", () => {
		expect(journalSince(null)).toBe("-30min")
		expect(journalSince("2026-09-06T06:16:10.000Z")).toBe("2026-09-06T06:16:10.000Z")
	})

	it("names the right unit", () => {
		expect(journalCommand(rootless, "abc123", null)).toContain("open-mcc@abc123")
	})
})

describe("turning a journal read into connection changes", () => {
	it("reports the kick and the rejoin from real output", async () => {
		const transport = transportReturning(REAL_OUTPUT)

		const reading = await readConnectionChanges(
			transport,
			rootless,
			"abc123",
			{ state: "joined", since: new Date("2026-09-06T06:00:00Z"), pid: "1689967" },
			null,
		)

		expect(reading.changes.map((change) => change.event)).toEqual([
			"instance.kicked",
			"instance.reconnected",
		])
	})

	it("advances the cursor to the last line it read, so the next read does not repeat it", async () => {
		const reading = await readConnectionChanges(
			transportReturning(REAL_OUTPUT),
			rootless,
			"abc123",
			UNOBSERVED_CONNECTION,
			null,
		)

		expect(reading.cursor).toBe("2026-09-06T06:16:10.000Z")
	})

	it("keeps the old cursor when the journal read fails, rather than skipping history", async () => {
		const reading = await readConnectionChanges(
			transportReturning("", 1),
			rootless,
			"abc123",
			UNOBSERVED_CONNECTION,
			"2026-09-06T05:00:00.000Z",
		)

		expect(reading.cursor).toBe("2026-09-06T05:00:00.000Z")
		expect(reading.changes).toEqual([])
	})

	it("keeps the old cursor when the journal had nothing new", async () => {
		const reading = await readConnectionChanges(
			transportReturning(""),
			rootless,
			"abc123",
			UNOBSERVED_CONNECTION,
			"2026-09-06T05:00:00.000Z",
		)

		expect(reading.cursor).toBe("2026-09-06T05:00:00.000Z")
	})
})

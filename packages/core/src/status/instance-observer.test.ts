import { describe, expect, it, vi } from "vitest"
import { UNOBSERVED_CONNECTION } from "./connection"
import { journalCommand, journalSince, readConnectionChanges } from "./instance-observer"

const REAL_OUTPUT = [
	"2026-09-06T14:15:38+0800 tjsx100 sh[1689967]: §8[MCC] Disconnected by Server :",
	"2026-09-06T14:15:38+0800 tjsx100 sh[1689967]: §8[MCC] Kicked by an operator",
	"2026-09-06T14:16:10+0800 tjsx100 sh[1702654]: §8[MCC] Server was successfully joined.",
].join("\n")

const transportReturning = (stdout: string, exitCode = 0) => ({
	exec: vi.fn(async () => ({ stdout, stderr: "", exitCode })),
})

describe("asking the host what the client logged", () => {
	it("reads the user journal, which is where the client's unit logs", () => {
		expect(journalCommand("abc123", null)).toContain("journalctl --user")
	})

	it("looks back further on a first read, then resumes from where it left off", () => {
		expect(journalSince(null)).toBe("-7d")
		expect(journalSince("2026-09-06T06:16:10.000Z")).toBe("2026-09-06 06:16:10")
	})

	it("gives journalctl a timestamp it can actually parse", () => {
		expect(journalSince("2026-09-06T06:16:10.000Z")).not.toContain("T")
		expect(journalSince("2026-09-06T06:16:10.000Z")).not.toContain("Z")
	})

	it("reads the journal in UTC so the cursor and the output agree", () => {
		expect(journalCommand("abc123", "2026-09-06T06:16:10.000Z")).toContain("--utc")
	})

	it("falls back to the seed window if the stored cursor is unusable", () => {
		expect(journalSince("not a date")).toBe("-7d")
	})

	it("names the right unit", () => {
		expect(journalCommand("abc123", null)).toContain("open-mcc@abc123")
	})
})

describe("the very first read of a bot that was already connected", () => {
	it("records it as joined from the last join in its history, not as unmeasured", async () => {
		const raw = [
			"2026-09-01T10:00:00+0800 h sh[1]: §8[MCC] Disconnected by Server :",
			"2026-09-01T10:00:05+0800 h sh[1]: §8[MCC] Server was successfully joined.",
		].join("\n")

		const reading = await readConnectionChanges(
			transportReturning(raw),
			"abc123",
			UNOBSERVED_CONNECTION,
			null,
		)

		expect(reading.changes).toHaveLength(1)
		expect(reading.changes[0]).toMatchObject({ state: "joined", event: "instance.joined" })
	})

	it("does not replay every historical change as if it just happened", async () => {
		const raw = [
			"2026-09-01T10:00:00+0800 h sh[1]: §8[MCC] Server was successfully joined.",
			"2026-09-02T10:00:00+0800 h sh[1]: §8[MCC] Disconnected by Server :",
			"2026-09-03T10:00:00+0800 h sh[2]: §8[MCC] Server was successfully joined.",
		].join("\n")

		const reading = await readConnectionChanges(
			transportReturning(raw),
			"abc123",
			UNOBSERVED_CONNECTION,
			null,
		)

		expect(reading.changes).toHaveLength(1)
		expect(reading.changes[0]?.at.toISOString()).toBe("2026-09-03T02:00:00.000Z")
	})

	it("records a bot that is currently off its server as interrupted", async () => {
		const raw = "2026-09-01T10:00:00+0800 h sh[1]: §8[MCC] Disconnected by Server : Server closed"

		const reading = await readConnectionChanges(
			transportReturning(raw),
			"abc123",
			UNOBSERVED_CONNECTION,
			null,
		)

		expect(reading.changes[0]).toMatchObject({ state: "interrupted", reason: "Server closed" })
	})
})

describe("turning a journal read into connection changes", () => {
	it("reports the kick and the rejoin from real output", async () => {
		const transport = transportReturning(REAL_OUTPUT)

		const reading = await readConnectionChanges(
			transport,
			"abc123",
			{ state: "joined", since: new Date("2026-09-06T06:00:00Z"), pid: "1689967" },
			"2026-09-06T06:00:00.000Z",
		)

		expect(reading.changes.map((change) => change.event)).toEqual([
			"instance.kicked",
			"instance.reconnected",
		])
	})

	it("advances the cursor to the last line it read, so the next read does not repeat it", async () => {
		const reading = await readConnectionChanges(
			transportReturning(REAL_OUTPUT),
			"abc123",
			UNOBSERVED_CONNECTION,
			null,
		)

		expect(reading.cursor).toBe("2026-09-06T06:16:10.000Z")
	})

	it("keeps the old cursor when the journal read fails, rather than skipping history", async () => {
		const reading = await readConnectionChanges(
			transportReturning("", 1),
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
			"abc123",
			UNOBSERVED_CONNECTION,
			"2026-09-06T05:00:00.000Z",
		)

		expect(reading.cursor).toBe("2026-09-06T05:00:00.000Z")
	})
})

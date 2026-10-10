import type { McpEventPage } from "@open-mcc/contracts/boundary/mcp"
import { type ReadCommand, readCommandText } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import { JOURNAL_MAX_LINES } from "../status/instance-observer"
import {
	drainJoinSightings,
	type JoinReading,
	type JoinSighting,
	readJoinSightings,
	respawnsFrom,
} from "./task-signals"

const CURSOR =
	"s=0123456789abcdef0123456789abcdef;i=1;b=0123456789abcdef0123456789abcdef;m=1;t=1;x=1"
const NEXT = "s=0123456789abcdef0123456789abcdef;i=2;b=0123456789abcdef0123456789abcdef;m=2;t=2;x=2"

const line = (stamp: string, pid: string, message: string): string =>
	`${stamp} host open-mcc[${pid}]: ${message}`

const JOINED = "[MCC] Server was successfully joined."

const reader = (stdout: string, exitCode = 0, stderr = "") => {
	const commands: string[] = []
	return {
		commands,
		exec: async (command: ReadCommand) => {
			commands.push(readCommandText(command))
			return { stdout, stderr, exitCode }
		},
	}
}

describe("reading joins out of the journal", () => {
	it("takes no joins from a seed read, so a week of history never fires a task", async () => {
		const made = reader(
			[
				line("2024-03-01T10:00:00+0000", "41", JOINED),
				line("2024-03-02T10:00:00+0000", "41", JOINED),
				`-- cursor: ${NEXT}`,
			].join("\n"),
		)
		const reading = await readJoinSightings(made, "inst-1", null)
		expect(reading.seeded).toBe(true)
		expect(reading.joins).toEqual([])
		expect(reading.cursor).toBe(NEXT)
	})

	it("takes every join in a resumed batch, including a second one for the same process", async () => {
		const made = reader(
			[
				line("2024-03-02T10:00:00+0000", "41", JOINED),
				line("2024-03-02T10:04:00+0000", "41", "[MCC] Disconnected by Server: timed out"),
				line("2024-03-02T10:05:00+0000", "41", JOINED),
				`-- cursor: ${NEXT}`,
			].join("\n"),
		)
		const reading = await readJoinSightings(made, "inst-1", CURSOR)
		expect(reading.joins).toEqual([
			{ process: "41", occurredAt: new Date("2024-03-02T10:00:00.000Z") },
			{ process: "41", occurredAt: new Date("2024-03-02T10:05:00.000Z") },
		])
	})

	it("takes a rejoin even when nothing logged the disconnect that came before it", async () => {
		const made = reader(
			[
				line("2024-03-02T10:00:00+0000", "41", JOINED),
				line("2024-03-02T10:05:00+0000", "41", JOINED),
				`-- cursor: ${NEXT}`,
			].join("\n"),
		)
		const reading = await readJoinSightings(made, "inst-1", CURSOR)
		expect(reading.joins).toHaveLength(2)
	})

	it("resumes from the stored cursor rather than from a clock reading", async () => {
		const made = reader(`-- cursor: ${NEXT}`)
		await readJoinSightings(made, "inst-1", CURSOR)
		expect(made.commands[0]).toContain(`--cursor ${JSON.stringify(CURSOR)}`)
		expect(made.commands[0]).not.toContain("--since")
	})

	it("keeps the stored cursor and reports a refusal the host named", async () => {
		const made = reader("", 1, "Failed to seek to cursor")
		const reading = await readJoinSightings(made, "inst-1", CURSOR)
		expect(reading.refused).toBe(true)
		expect(reading.cursor).toBe(CURSOR)
		expect(reading.joins).toEqual([])
	})

	it("does not call a read that merely failed a refusal", async () => {
		const made = reader("", 1, "Permission denied")
		const reading = await readJoinSightings(made, "inst-1", CURSOR)
		expect(reading.refused).toBe(false)
	})

	it("reports a full batch so the drain knows there is more behind it", async () => {
		const many = Array.from({ length: JOURNAL_MAX_LINES + 1 }, (_, index) =>
			line("2024-03-02T10:00:00+0000", "41", `chat ${index}`),
		)
		const made = reader([...many, `-- cursor: ${NEXT}`].join("\n"))
		expect((await readJoinSightings(made, "inst-1", CURSOR)).full).toBe(true)
	})
})

describe("draining joins", () => {
	const drainOver = (readings: JoinReading[]) => {
		const recorded: JoinSighting[][] = []
		const saved: string[] = []
		const asked: Array<string | null> = []
		let index = 0
		return {
			recorded,
			saved,
			asked,
			drain: {
				read: async (cursor: string | null) => {
					asked.push(cursor)
					const reading = readings[index] ?? readings[readings.length - 1]
					index += 1
					if (!reading) throw new Error("no reading left")
					return reading
				},
				record: async (joins: readonly JoinSighting[]) => {
					recorded.push([...joins])
				},
				saveCursor: async (cursor: string) => {
					saved.push(cursor)
				},
			},
		}
	}

	it("reads once and stores the cursor when the batch was not full", async () => {
		const made = drainOver([
			{ joins: [], cursor: NEXT, seeded: false, refused: false, full: false },
		])
		await drainJoinSightings(made.drain, CURSOR)
		expect(made.asked).toEqual([CURSOR])
		expect(made.saved).toEqual([NEXT])
	})

	it("keeps reading while batches come back full, so a backlog does not stall", async () => {
		const made = drainOver([
			{ joins: [], cursor: NEXT, seeded: false, refused: false, full: true },
			{ joins: [], cursor: `${NEXT}0`, seeded: false, refused: false, full: false },
		])
		await drainJoinSightings(made.drain, CURSOR)
		expect(made.asked).toEqual([CURSOR, NEXT])
	})

	it("re-seeds in the same cycle when the host refused the stored cursor", async () => {
		const made = drainOver([
			{ joins: [], cursor: CURSOR, seeded: false, refused: true, full: false },
			{ joins: [], cursor: NEXT, seeded: true, refused: false, full: false },
		])
		await drainJoinSightings(made.drain, CURSOR)
		expect(made.asked).toEqual([CURSOR, null])
		expect(made.saved).toEqual([NEXT])
	})

	it("stores no cursor the host did not name", async () => {
		const made = drainOver([
			{ joins: [], cursor: null, seeded: false, refused: false, full: false },
		])
		await drainJoinSightings(made.drain, null)
		expect(made.saved).toEqual([])
	})
})

describe("reading respawns off the client's event feed", () => {
	const page = (events: McpEventPage["events"], latestId: number): McpEventPage => ({
		latestId,
		events,
	})

	const event = (id: number, type: string, timestampUtc: string) => ({
		id,
		timestampUtc,
		type,
		subject: undefined,
	})

	it("takes nothing from a seed read and stores where the feed had got to", async () => {
		const reading = respawnsFrom(
			page([event(9, "respawn", "2024-03-02T10:00:00Z")], 9),
			null,
			new Date(),
		)
		expect(reading.seeded).toBe(true)
		expect(reading.respawns).toEqual([])
		expect(reading.cursor).toBe(9)
	})

	it("takes only respawn events, keyed on the client's own ids", () => {
		const reading = respawnsFrom(
			page(
				[event(10, "death", "2024-03-02T10:00:00Z"), event(11, "respawn", "2024-03-02T10:00:05Z")],
				11,
			),
			9,
			new Date(),
		)
		expect(reading.respawns).toEqual([
			{ eventId: 11, occurredAt: new Date("2024-03-02T10:00:05.000Z") },
		])
		expect(reading.cursor).toBe(11)
	})

	it("never moves the cursor backwards when a rejoin cleared the client's buffer", () => {
		const reading = respawnsFrom(page([], 0), 5000, new Date())
		expect(reading.cursor).toBe(5000)
		expect(reading.respawns).toEqual([])
	})

	it("takes nothing it has already taken, even when the page repeats it", () => {
		const reading = respawnsFrom(
			page([event(11, "respawn", "2024-03-02T10:00:05Z")], 11),
			11,
			new Date(),
		)
		expect(reading.respawns).toEqual([])
	})

	it("stamps an unreadable timestamp with the moment of the read", () => {
		const at = new Date("2024-03-02T12:00:00.000Z")
		const reading = respawnsFrom(page([event(12, "respawn", "not a date")], 12), 11, at)
		expect(reading.respawns).toEqual([{ eventId: 12, occurredAt: at }])
	})
})

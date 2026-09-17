import { type HostReader, type ReadCommand, readCommandText } from "@open-mcc/transport"
import { describe, expect, it, vi } from "vitest"
import { type ConnectionChange, UNOBSERVED_CONNECTION } from "./connection"
import {
	drainConnectionChanges,
	JOURNAL_DRAIN_ROUNDS,
	JOURNAL_MAX_LINES,
	journalCommand,
	journalResume,
	readConnectionChanges,
	SEED_WINDOW,
} from "./instance-observer"

const cursorAt = (index: number): string =>
	`s=${"a".repeat(32)};i=${index.toString(16)};b=${"b".repeat(32)};m=${(index + 1).toString(16)};t=${(index + 1).toString(16)};x=${"c".repeat(16)}`

const LEGACY_CURSOR = "2026-09-06T06:16:10.000Z"

const REAL_OUTPUT = [
	"2026-09-06T14:15:38+0800 tjsx100 sh[1689967]: §8[MCC] Disconnected by Server :",
	"2026-09-06T14:15:38+0800 tjsx100 sh[1689967]: §8[MCC] Kicked by an operator",
	"2026-09-06T14:16:10+0800 tjsx100 sh[1702654]: §8[MCC] Server was successfully joined.",
].join("\n")

const shown = (stdout: string, cursor: string): string =>
	stdout.length === 0 ? stdout : `${stdout}\n-- cursor: ${cursor}\n`

const transportReturning = (stdout: string, exitCode = 0, stderr = "") => ({
	exec: vi.fn(async () => ({ stdout: shown(stdout, cursorAt(9)), stderr, exitCode })),
})

describe("asking the host where the client's log left off", () => {
	it("reads the user journal, which is where the client's unit logs", () => {
		expect(journalCommand("abc123", null)).toContain("journalctl --user")
	})

	it("names the right unit", () => {
		expect(journalCommand("abc123", null)).toContain("open-mcc@abc123")
	})

	it("asks journalctl for its own position, which is what the next read resumes from", () => {
		expect(journalCommand("abc123", null)).toContain("--show-cursor")
		expect(journalCommand("abc123", cursorAt(3))).toContain("--show-cursor")
	})

	it("looks back over the seed window on a first read, with no position to resume from", () => {
		const command = journalCommand("abc123", null)

		expect(command).toContain(`--since "${SEED_WINDOW}"`)
		expect(command).not.toContain("--cursor")
		expect(command).toContain(`-n ${JOURNAL_MAX_LINES}`)
	})

	it("resumes from the stored position rather than a window, and asks for one line beyond the cap", () => {
		const command = journalCommand("abc123", cursorAt(3))

		expect(command).toContain(`--cursor "${cursorAt(3)}"`)
		expect(command).not.toContain("--since")
		expect(command).toContain(`-n ${JOURNAL_MAX_LINES + 1}`)
	})

	it("reads the journal in UTC, so a line's time and the recorded change agree", () => {
		expect(journalCommand("abc123", cursorAt(3))).toContain("--utc")
	})

	it("treats a stored timestamp as no position at all, because it is not a journald cursor", () => {
		expect(journalResume(LEGACY_CURSOR)).toBeNull()
		expect(journalResume(null)).toBeNull()
		expect(journalResume(cursorAt(3))).toBe(cursorAt(3))
	})

	it("seeds from the window when the stored position is a timestamp, rather than spending it", () => {
		const command = journalCommand("abc123", LEGACY_CURSOR)

		expect(command).toContain(`--since "${SEED_WINDOW}"`)
		expect(command).not.toContain("--cursor")
		expect(command).not.toContain(LEGACY_CURSOR)
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

	it("takes only the latest signal when the stored position was a timestamp", async () => {
		const raw = [
			"2026-09-01T10:00:00+0800 h sh[1]: §8[MCC] Server was successfully joined.",
			"2026-09-02T10:00:00+0800 h sh[1]: §8[MCC] Disconnected by Server : Server closed",
		].join("\n")

		const reading = await readConnectionChanges(
			transportReturning(raw),
			"abc123",
			{ state: "joined", since: new Date("2026-09-01T00:00:00Z"), pid: "1" },
			LEGACY_CURSOR,
		)

		expect(reading.changes.map((change) => change.event)).toEqual(["instance.connection_lost"])
		expect(reading.cursor).toBe(cursorAt(9))
	})
})

describe("turning a journal read into connection changes", () => {
	it("reports the kick and the rejoin from real output", async () => {
		const transport = transportReturning(REAL_OUTPUT)

		const reading = await readConnectionChanges(
			transport,
			"abc123",
			{ state: "joined", since: new Date("2026-09-06T06:00:00Z"), pid: "1689967" },
			cursorAt(1),
		)

		expect(reading.changes.map((change) => change.event)).toEqual([
			"instance.kicked",
			"instance.reconnected",
		])
	})

	it("advances to the position journalctl reported, not to a line's clock reading", async () => {
		const reading = await readConnectionChanges(
			transportReturning(REAL_OUTPUT),
			"abc123",
			UNOBSERVED_CONNECTION,
			null,
		)

		expect(reading.cursor).toBe(cursorAt(9))
	})

	it("keeps the old position when the journal read fails, rather than skipping history", async () => {
		const reading = await readConnectionChanges(
			transportReturning("", 1, "Failed to add filter for units: Invalid argument\n"),
			"abc123",
			UNOBSERVED_CONNECTION,
			cursorAt(4),
		)

		expect(reading.cursor).toBe(cursorAt(4))
		expect(reading.changes).toEqual([])
		expect(reading.refused).toBe(false)
	})

	it("keeps the old position when the journal had nothing new", async () => {
		const reading = await readConnectionChanges(
			{
				exec: vi.fn(async () => ({
					stdout: `-- No entries --\n-- cursor: ${cursorAt(99)}\n`,
					stderr: "",
					exitCode: 0,
				})),
			},
			"abc123",
			UNOBSERVED_CONNECTION,
			cursorAt(4),
		)

		expect(reading.cursor).toBe(cursorAt(4))
		expect(reading.changes).toEqual([])
	})
})

const REFUSAL = "Failed to seek to cursor: Invalid argument\n"

describe("a stored position the host will not accept", () => {
	it("is reported as refused, so the read is not mistaken for a quiet journal", async () => {
		const reading = await readConnectionChanges(
			transportReturning("", 1, REFUSAL),
			"abc123",
			UNOBSERVED_CONNECTION,
			cursorAt(4),
		)

		expect(reading.refused).toBe(true)
		expect(reading.cursor).toBe(cursorAt(4))
	})

	it("is not claimed when the host failed for another reason", async () => {
		const reading = await readConnectionChanges(
			transportReturning("", 1, "Failed to add filter for units: Invalid argument\n"),
			"abc123",
			UNOBSERVED_CONNECTION,
			cursorAt(4),
		)

		expect(reading.refused).toBe(false)
	})

	it("is not claimed for a seed read, which had no position to refuse", async () => {
		const reading = await readConnectionChanges(
			transportReturning("", 1, REFUSAL),
			"abc123",
			UNOBSERVED_CONNECTION,
			null,
		)

		expect(reading.refused).toBe(false)
	})
})

type Entry = { line: string; cursor: string }

const JOURNAL_BASE_MS = Date.parse("2026-09-06T00:00:00Z")

const journalLine = (index: number, message: string): string =>
	`${new Date(JOURNAL_BASE_MS + index * 1_000).toISOString().slice(0, 19)}+0000 tjsx100 sh[4242]: §8[MCC] ${message}`

const busyJournal = (total: number, joinAt: number, disconnectAt: number): string[] =>
	Array.from({ length: total }, (_, index) =>
		index === joinAt
			? journalLine(index, "Server was successfully joined.")
			: index === disconnectAt
				? journalLine(index, "Disconnected by Server : Server closed")
				: journalLine(index, `Chat: line ${index}`),
	)

const twoJoinJournal = (total: number, first: number, second: number): string[] =>
	Array.from({ length: total }, (_, index) =>
		index === first || index === second
			? journalLine(index, "Server was successfully joined.")
			: journalLine(index, `Chat: line ${index}`),
	)

const kickSplitJournal = (total: number, at: number): string[] =>
	Array.from({ length: total }, (_, index) =>
		index === at
			? journalLine(index, "Disconnected by Server :")
			: index === at + 1
				? journalLine(at, "Kicked by an operator")
				: journalLine(index, `Chat: line ${index}`),
	)

const quotedAfter = (command: string, flag: string): string | undefined =>
	new RegExp(`${flag} "([^"]*)"`).exec(command)?.[1]

const linesAsked = (command: string): number => Number(/ -n (\d+)/.exec(command)?.[1] ?? "0")

const answered = (entries: readonly Entry[], tail: string) => ({
	stdout:
		entries.length === 0
			? `-- No entries --\n-- cursor: ${tail}\n`
			: `${entries.map((entry) => entry.line).join("\n")}\n-- cursor: ${entries.at(-1)?.cursor ?? ""}\n`,
	stderr: "",
	exitCode: 0,
})

const hostWithJournal = (journal: readonly string[]) => {
	const entries: Entry[] = journal.map((line, index) => ({ line, cursor: cursorAt(index) }))
	const tail = entries.at(-1)?.cursor ?? cursorAt(0)
	const commands: string[] = []
	return {
		commands,
		exec: vi.fn(async (command: ReadCommand) => {
			const text = readCommandText(command)
			commands.push(text)
			const asked = linesAsked(text)
			const resume = quotedAfter(text, "--cursor")
			if (resume === undefined) return answered(entries.slice(-asked), tail)
			const from = entries.findIndex((entry) => entry.cursor === resume)
			if (from < 0) return { stdout: "", stderr: REFUSAL, exitCode: 1 }
			return answered(entries.slice(from, from + asked), tail)
		}),
	}
}

const WAS_DOWN = { state: "down", since: new Date("2026-09-05T00:00:00Z"), pid: null } as const

const WAS_JOINED = {
	state: "joined",
	since: new Date("2026-09-05T00:00:00Z"),
	pid: "4242",
} as const

const RESUMED_FROM = cursorAt(0)

describe("a bot that logs more than one batch between polls", () => {
	it("reports the oldest signals in the backlog instead of skipping past them", async () => {
		const journal = busyJournal(JOURNAL_MAX_LINES + 500, 5, JOURNAL_MAX_LINES + 400)

		const reading = await readConnectionChanges(
			hostWithJournal(journal),
			"abc123",
			WAS_DOWN,
			RESUMED_FROM,
		)

		expect(reading.changes.map((change) => change.event)).toEqual(["instance.reconnected"])
		expect(reading.changes[0]?.at.toISOString()).toBe("2026-09-06T00:00:05.000Z")
		expect(reading.cursor).toBe(cursorAt(JOURNAL_MAX_LINES))
	})

	it("flags a batch that filled the cap so the poller keeps draining", async () => {
		const reading = await readConnectionChanges(
			hostWithJournal(busyJournal(JOURNAL_MAX_LINES + 500, 5, JOURNAL_MAX_LINES + 400)),
			"abc123",
			WAS_DOWN,
			RESUMED_FROM,
		)

		expect(reading.full).toBe(true)
	})

	it("does not flag a batch that fell short of the cap", async () => {
		const reading = await readConnectionChanges(
			hostWithJournal(busyJournal(JOURNAL_MAX_LINES - 1, 5, 100)),
			"abc123",
			WAS_DOWN,
			RESUMED_FROM,
		)

		expect(reading.full).toBe(false)
	})

	it("does not flag a seed read, which is behind nothing", async () => {
		const reading = await readConnectionChanges(
			hostWithJournal(busyJournal(JOURNAL_MAX_LINES + 500, 5, JOURNAL_MAX_LINES + 400)),
			"abc123",
			UNOBSERVED_CONNECTION,
			null,
		)

		expect(reading.full).toBe(false)
	})

	it("reads the line at the batch boundary using the withheld line as lookahead", async () => {
		const reading = await readConnectionChanges(
			hostWithJournal(kickSplitJournal(2_100, JOURNAL_MAX_LINES - 1)),
			"abc123",
			WAS_JOINED,
			RESUMED_FROM,
		)

		expect(reading.changes.map((change) => change.event)).toEqual(["instance.kicked"])
		expect(reading.changes[0]?.reason).toBe("Kicked by an operator")
	})

	it("does not judge a signal that lies in the withheld lookahead line", async () => {
		const reading = await readConnectionChanges(
			hostWithJournal(busyJournal(2_100, 5, JOURNAL_MAX_LINES)),
			"abc123",
			WAS_DOWN,
			RESUMED_FROM,
		)

		expect(reading.changes.map((change) => change.event)).toEqual(["instance.reconnected"])
	})

	it("resumes at the withheld line, so the line it did not judge is not skipped", async () => {
		const reading = await readConnectionChanges(
			hostWithJournal(busyJournal(2_100, 5, JOURNAL_MAX_LINES)),
			"abc123",
			WAS_DOWN,
			RESUMED_FROM,
		)

		expect(reading.cursor).toBe(cursorAt(JOURNAL_MAX_LINES))
	})

	it("reads every line of a batch that exactly fills the cap, and does not call it full", async () => {
		const reading = await readConnectionChanges(
			hostWithJournal(busyJournal(JOURNAL_MAX_LINES, JOURNAL_MAX_LINES - 1, 100)),
			"abc123",
			WAS_DOWN,
			RESUMED_FROM,
		)

		expect(reading.full).toBe(false)
		expect(reading.changes.map((change) => change.event)).toEqual(["instance.reconnected"])
		expect(reading.cursor).toBe(cursorAt(JOURNAL_MAX_LINES - 1))
	})
})

const OVERSIZED_JOURNAL = busyJournal(JOURNAL_MAX_LINES + 500, 5, JOURNAL_MAX_LINES + 400)

describe("which end of an oversized journal each kind of read keeps", () => {
	it("keeps the newest lines on a first read, so adopting a busy bot replays nothing", async () => {
		const reading = await readConnectionChanges(
			hostWithJournal(OVERSIZED_JOURNAL),
			"abc123",
			UNOBSERVED_CONNECTION,
			null,
		)

		expect(reading.cursor).toBe(cursorAt(JOURNAL_MAX_LINES + 499))
		expect(reading.changes).toHaveLength(1)
		expect(reading.changes[0]).toMatchObject({
			state: "interrupted",
			event: "instance.connection_lost",
		})
	})

	it("keeps the oldest lines on a resumed read, so a backlog is consumed in order", async () => {
		const reading = await readConnectionChanges(
			hostWithJournal(OVERSIZED_JOURNAL),
			"abc123",
			WAS_DOWN,
			RESUMED_FROM,
		)

		expect(reading.cursor).toBe(cursorAt(JOURNAL_MAX_LINES))
		expect(reading.changes.map((change) => change.event)).toEqual(["instance.reconnected"])
		expect(reading.full).toBe(true)
	})
})

const countingDrain = (host: Pick<HostReader, "exec"> | undefined) => {
	const cursors: string[] = []
	const changes: ConnectionChange[] = []
	const refused: string[] = []
	const counts = { leases: 0, releases: 0 }
	return {
		cursors,
		changes,
		refused,
		counts,
		onRefused: (cursor: string) => {
			refused.push(cursor)
		},
		lease: async () => {
			if (host === undefined) return undefined
			counts.leases += 1
			return {
				exec: host.exec,
				release: () => {
					counts.releases += 1
				},
			}
		},
		record: async (recorded: ConnectionChange[]) => {
			changes.push(...recorded)
		},
		saveCursor: async (cursor: string) => {
			cursors.push(cursor)
		},
	}
}

describe("draining a bot that has fallen behind", () => {
	it("walks forward over bounded rounds and releases every lease", async () => {
		const drain = countingDrain(hostWithJournal(busyJournal(12_000, 5, 11_000)))

		const outcome = await drainConnectionChanges(drain, "abc123", WAS_DOWN, RESUMED_FROM)

		expect(outcome).toBe("drained")
		expect(drain.counts.leases).toBe(JOURNAL_DRAIN_ROUNDS)
		expect(drain.counts.releases).toBe(JOURNAL_DRAIN_ROUNDS)
		expect(drain.cursors).toEqual([
			cursorAt(2_000),
			cursorAt(4_000),
			cursorAt(6_000),
			cursorAt(8_000),
		])
		expect(drain.refused).toEqual([])
	})

	it("holds back a signal sighted only as lookahead, so it is judged once with its reason", async () => {
		const drain = countingDrain(hostWithJournal(kickSplitJournal(2_100, JOURNAL_MAX_LINES)))

		await drainConnectionChanges(drain, "abc123", WAS_JOINED, RESUMED_FROM)

		expect(drain.changes.map((change) => change.event)).toEqual(["instance.kicked"])
		expect(drain.changes[0]?.reason).toBe("Kicked by an operator")
	})

	it("reads once when the batch did not fill the cap", async () => {
		const drain = countingDrain(hostWithJournal(busyJournal(JOURNAL_MAX_LINES - 1, 5, 100)))

		await drainConnectionChanges(drain, "abc123", WAS_DOWN, RESUMED_FROM)

		expect(drain.counts.leases).toBe(1)
		expect(drain.counts.releases).toBe(1)
	})

	it("saves nothing when the only line at the stored position is the one already read", async () => {
		const drain = countingDrain(hostWithJournal(busyJournal(1, 0, -1)))

		await drainConnectionChanges(drain, "abc123", WAS_JOINED, RESUMED_FROM)

		expect(drain.cursors).toEqual([])
		expect(drain.counts.leases).toBe(1)
	})

	it("carries the connection state between rounds, so a backlog is not double-reported", async () => {
		const drain = countingDrain(hostWithJournal(twoJoinJournal(4_000, 5, JOURNAL_MAX_LINES + 500)))

		await drainConnectionChanges(drain, "abc123", WAS_DOWN, RESUMED_FROM)

		expect(drain.changes.map((change) => change.event)).toEqual(["instance.reconnected"])
	})

	it("gives up the cycle when the journal lease is refused", async () => {
		const drain = countingDrain(undefined)

		const outcome = await drainConnectionChanges(drain, "abc123", WAS_DOWN, RESUMED_FROM)

		expect(outcome).toBe("unleased")
		expect(drain.cursors).toEqual([])
	})

	it("releases the lease when the read itself throws", async () => {
		const counts = { releases: 0 }

		await expect(
			drainConnectionChanges(
				{
					lease: async () => ({
						exec: async () => {
							throw new Error("read connection lost")
						},
						release: () => {
							counts.releases += 1
						},
					}),
					record: async () => undefined,
					saveCursor: async () => undefined,
					onRefused: () => undefined,
				},
				"abc123",
				WAS_DOWN,
				RESUMED_FROM,
			),
		).rejects.toThrow("read connection lost")

		expect(counts.releases).toBe(1)
	})
})

const VACUUMED = cursorAt(99_999)

describe("a bot whose stored position the host no longer accepts", () => {
	it("reads the journal afresh in the same cycle, rather than reading nothing", async () => {
		const drain = countingDrain(hostWithJournal(busyJournal(50, 5, 40)))

		const outcome = await drainConnectionChanges(drain, "abc123", WAS_JOINED, VACUUMED)

		expect(outcome).toBe("drained")
		expect(drain.refused).toEqual([VACUUMED])
		expect(drain.changes.map((change) => change.event)).toEqual(["instance.connection_lost"])
		expect(drain.cursors).toEqual([cursorAt(49)])
	})

	it("takes a second lease for the fresh read, and releases both", async () => {
		const drain = countingDrain(hostWithJournal(busyJournal(50, 5, 40)))

		await drainConnectionChanges(drain, "abc123", WAS_JOINED, VACUUMED)

		expect(drain.counts.leases).toBe(2)
		expect(drain.counts.releases).toBe(2)
	})

	it("does not read afresh when the host failed for a reason that is not the position", async () => {
		const host = {
			exec: vi.fn(async () => ({
				stdout: "",
				stderr: "Failed to add filter for units: Invalid argument\n",
				exitCode: 1,
			})),
		}
		const drain = countingDrain(host)

		await drainConnectionChanges(drain, "abc123", WAS_JOINED, RESUMED_FROM)

		expect(drain.refused).toEqual([])
		expect(drain.cursors).toEqual([])
		expect(drain.counts.leases).toBe(1)
	})

	it("reads the journal afresh when the stored position is a timestamp from before cursors", async () => {
		const drain = countingDrain(hostWithJournal(busyJournal(50, 5, 40)))

		await drainConnectionChanges(drain, "abc123", WAS_JOINED, LEGACY_CURSOR)

		expect(drain.refused).toEqual([])
		expect(drain.changes.map((change) => change.event)).toEqual(["instance.connection_lost"])
		expect(drain.cursors).toEqual([cursorAt(49)])
	})
})

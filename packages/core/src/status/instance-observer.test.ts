import { type HostReader, type ReadCommand, readCommandText } from "@open-mcc/transport"
import { describe, expect, it, vi } from "vitest"
import { type ConnectionChange, type ConnectionCurrent, UNOBSERVED_CONNECTION } from "./connection"
import {
	drainConnectionChanges,
	JOURNAL_DRAIN_ROUNDS,
	JOURNAL_MAX_LINES,
	journalCommand,
	journalSince,
	readConnectionChanges,
	SEED_WINDOW,
} from "./instance-observer"

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
		expect(journalSince("2026-09-06T06:16:10.000Z")).toBe("2026-09-06 06:16:10 UTC")
	})

	it("gives journalctl a timestamp it can actually parse", () => {
		expect(journalSince("2026-09-06T06:16:10.000Z")).not.toMatch(/\dT\d/)
		expect(journalSince("2026-09-06T06:16:10.000Z")).not.toMatch(/Z$/)
	})

	it("names the zone, because --utc governs output only and the cursor is UTC", () => {
		expect(journalSince("2026-09-06T06:16:10.000Z")).toMatch(/ UTC$/)
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

const SIGPIPE_EXIT = 141

const headLimit = (command: string): number | undefined => {
	const digits = /\|\s*head\s+-n\s+(\d+)/.exec(command)?.[1]
	return digits === undefined ? undefined : Number(digits)
}

const tailLimit = (command: string): number | undefined => {
	const digits = /journalctl[^|]*\s-n\s+(\d+)/.exec(command)?.[1]
	return digits === undefined ? undefined : Number(digits)
}

const writerStatusIgnored = (command: string): boolean => /\|\|\s*true\s*;?\s*\}/.test(command)

const sinceLimit = (command: string): number | undefined => {
	const stamp = /--since\s+"([^"]+)"/.exec(command)?.[1]
	if (stamp === undefined || stamp === SEED_WINDOW) return undefined
	return Date.parse(`${stamp.replace(" UTC", "").replace(" ", "T")}Z`)
}

const loggedAt = (line: string): number => Date.parse(line.slice(0, line.indexOf(" ")))

const hostWithJournal = (journal: readonly string[]) => {
	const statuses: number[] = []
	return {
		statuses,
		exec: vi.fn(async (command: ReadCommand) => {
			const text = readCommandText(command)
			const since = sinceLimit(text)
			const window =
				since === undefined ? journal.slice() : journal.filter((line) => loggedAt(line) >= since)
			const head = headLimit(text)
			const tail = tailLimit(text)
			const kept =
				head !== undefined
					? window.slice(0, head)
					: tail === undefined
						? window
						: window.slice(-tail)
			const closedEarly = head !== undefined && kept.length < window.length
			const exitCode = closedEarly && !writerStatusIgnored(text) ? SIGPIPE_EXIT : 0
			statuses.push(exitCode)
			return { stdout: kept.length === 0 ? "" : `${kept.join("\n")}\n`, stderr: "", exitCode }
		}),
	}
}

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

const denseSecondJournal = (dense: number): string[] => [
	...Array.from({ length: dense }, (_, index) => journalLine(0, `Chat: line ${index}`)),
	journalLine(1, "Server was successfully joined."),
]

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

const hostWhereJournalctlFails = () => {
	const statuses: number[] = []
	return {
		statuses,
		exec: vi.fn(async (command: ReadCommand) => {
			const exitCode = writerStatusIgnored(readCommandText(command)) ? 0 : 1
			statuses.push(exitCode)
			return { stdout: "", stderr: "Failed to add filter for units", exitCode }
		}),
	}
}

const WAS_DOWN = { state: "down", since: new Date("2026-09-05T00:00:00Z"), pid: null } as const

const WAS_JOINED = {
	state: "joined",
	since: new Date("2026-09-05T00:00:00Z"),
	pid: "4242",
} as const

const RESUMED_FROM = "2026-09-05T00:00:00.000Z"

describe("a bot that logs more than one window between polls", () => {
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
		expect(reading.cursor).toBe("2026-09-06T00:33:18.000Z")
	})

	it("succeeds when the bounding step closes the pipe on journalctl", async () => {
		const host = hostWithJournal(busyJournal(JOURNAL_MAX_LINES + 500, 5, JOURNAL_MAX_LINES + 400))

		const reading = await readConnectionChanges(host, "abc123", WAS_DOWN, RESUMED_FROM)

		expect(host.statuses).toEqual([0])
		expect(reading.changes).toHaveLength(1)
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

	it("withholds the last line of a full batch, which may carry a signal's continuation", async () => {
		const reading = await readConnectionChanges(
			hostWithJournal(kickSplitJournal(2_100, JOURNAL_MAX_LINES - 1)),
			"abc123",
			WAS_JOINED,
			RESUMED_FROM,
		)

		expect(reading.changes).toEqual([])
		expect(reading.cursor).toBe("2026-09-06T00:33:18.000Z")
	})

	it("holds its cursor when journalctl fails behind the bound that swallows its status", async () => {
		const host = hostWhereJournalctlFails()

		const reading = await readConnectionChanges(host, "abc123", WAS_DOWN, RESUMED_FROM)

		expect(host.statuses).toEqual([0])
		expect(reading.changes).toEqual([])
		expect(reading.cursor).toBe(RESUMED_FROM)
		expect(reading.full).toBe(false)
	})
})

const OVERSIZED_JOURNAL = busyJournal(JOURNAL_MAX_LINES + 500, 5, JOURNAL_MAX_LINES + 400)

describe("which end of an oversized window each kind of read keeps", () => {
	it("keeps the newest lines on a first read, so adopting a busy bot replays nothing", async () => {
		const reading = await readConnectionChanges(
			hostWithJournal(OVERSIZED_JOURNAL),
			"abc123",
			UNOBSERVED_CONNECTION,
			null,
		)

		expect(reading.cursor).toBe("2026-09-06T00:41:39.000Z")
		expect(reading.changes).toHaveLength(1)
		expect(reading.changes[0]).toMatchObject({
			state: "interrupted",
			event: "instance.connection_lost",
		})
		expect(reading.full).toBe(false)
	})

	it("keeps the oldest lines on a resumed read, so a backlog is consumed in order", async () => {
		const reading = await readConnectionChanges(
			hostWithJournal(OVERSIZED_JOURNAL),
			"abc123",
			WAS_DOWN,
			RESUMED_FROM,
		)

		expect(reading.cursor).toBe("2026-09-06T00:33:18.000Z")
		expect(reading.changes.map((change) => change.event)).toEqual(["instance.reconnected"])
		expect(reading.full).toBe(true)
	})
})

const countingDrain = (host: Pick<HostReader, "exec"> | undefined) => {
	const cursors: string[] = []
	const changes: ConnectionChange[] = []
	const counts = { leases: 0, releases: 0 }
	return {
		cursors,
		changes,
		counts,
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
		expect(drain.cursors).toHaveLength(JOURNAL_DRAIN_ROUNDS)
		expect(drain.cursors.at(-1)).toBe("2026-09-06T02:13:12.000Z")
	})

	it("reads once when the batch did not fill the cap", async () => {
		const drain = countingDrain(hostWithJournal(busyJournal(JOURNAL_MAX_LINES - 1, 5, 100)))

		await drainConnectionChanges(drain, "abc123", WAS_DOWN, RESUMED_FROM)

		expect(drain.counts.leases).toBe(1)
		expect(drain.counts.releases).toBe(1)
	})

	it("escapes a second that overflows the cap instead of re-reading it forever", async () => {
		const host = hostWithJournal(denseSecondJournal(JOURNAL_MAX_LINES + 500))
		const recorded: ConnectionChange[] = []
		let current: ConnectionCurrent = WAS_DOWN
		let cursor: string | null = RESUMED_FROM

		for (let cycle = 0; cycle < 5; cycle += 1) {
			await drainConnectionChanges(
				{
					lease: async () => ({ exec: host.exec, release: () => undefined }),
					record: async (changes) => {
						recorded.push(...changes)
						const last = changes.at(-1)
						if (last !== undefined) current = { state: last.state, since: last.at, pid: last.pid }
					},
					saveCursor: async (next) => {
						cursor = next
					},
				},
				"abc123",
				current,
				cursor,
			)
		}

		expect(cursor).toBe("2026-09-06T00:00:01.000Z")
		expect(recorded.map((change) => change.event)).toEqual(["instance.reconnected"])
	})

	it("carries the connection state between rounds, so a backlog is not double-reported", async () => {
		const drain = countingDrain(hostWithJournal(twoJoinJournal(4_000, 5, JOURNAL_MAX_LINES + 500)))

		await drainConnectionChanges(drain, "abc123", WAS_DOWN, RESUMED_FROM)

		expect(drain.changes.map((change) => change.event)).toEqual(["instance.reconnected"])
	})

	it("keeps a disconnect's reason when the cap falls between it and the line carrying it", async () => {
		const drain = countingDrain(hostWithJournal(kickSplitJournal(2_100, JOURNAL_MAX_LINES - 1)))

		await drainConnectionChanges(drain, "abc123", WAS_JOINED, RESUMED_FROM)

		expect(drain.changes.map((change) => change.event)).toEqual(["instance.kicked"])
		expect(drain.changes[0]?.reason).toBe("Kicked by an operator")
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
				},
				"abc123",
				WAS_DOWN,
				RESUMED_FROM,
			),
		).rejects.toThrow("read connection lost")

		expect(counts.releases).toBe(1)
	})
})

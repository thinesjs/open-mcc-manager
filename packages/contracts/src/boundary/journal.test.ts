import { describe, expect, it } from "vitest"
import {
	connectionSignals,
	isJournalCursor,
	journalBatch,
	journalRefusedCursor,
	parseJournal,
	parseJournalLine,
	stripColour,
} from "./journal"

const REAL = [
	"2026-09-06T14:15:38+0800 tjsx100 sh[1689967]: §8[MCC] Disconnected by Server :",
	"2026-09-06T14:15:38+0800 tjsx100 sh[1689967]: §8[MCC] Kicked by an operator",
	"2026-09-06T14:16:10+0800 tjsx100 sh[1702654]: §8[MCC] Server was successfully joined.",
].join("\n")

describe("reading the client's own log", () => {
	it("takes the time, the process and the message from a real line", () => {
		const line = parseJournalLine(
			"2026-09-06T14:16:10+0800 tjsx100 sh[1702654]: §8[MCC] Server was successfully joined.",
		)

		expect(line?.pid).toBe("1702654")
		expect(line?.message).toBe("[MCC] Server was successfully joined.")
		expect(line?.at.toISOString()).toBe("2026-09-06T06:16:10.000Z")
	})

	it("strips the colour codes the client writes", () => {
		expect(stripColour("§8[MCC] §ahello")).toBe("[MCC] hello")
	})

	it("skips lines it cannot read rather than throwing", () => {
		expect(parseJournal("-- Logs begin --\nnot a log line\n")).toEqual([])
	})
})

describe("turning log lines into connection changes", () => {
	it("sees a join", () => {
		const signals = connectionSignals(parseJournal(REAL))

		expect(signals.some((signal) => signal.kind === "joined")).toBe(true)
	})

	it("takes the kick reason from the line after the disconnect", () => {
		const [first] = connectionSignals(parseJournal(REAL))

		expect(first).toMatchObject({ kind: "disconnected", reason: "Kicked by an operator" })
	})

	it("keeps the reason when the client puts it on the same line", () => {
		const raw = "2026-09-06T14:15:38+0800 h sh[1]: §8[MCC] Disconnected by Server : You are banned"
		const [signal] = connectionSignals(parseJournal(raw))

		expect(signal).toMatchObject({ kind: "disconnected", reason: "You are banned" })
	})

	it("does not borrow a reason from a different run of the client", () => {
		const raw = [
			"2026-09-06T14:15:38+0800 h sh[111]: §8[MCC] Disconnected by Server :",
			"2026-09-06T14:16:10+0800 h sh[222]: §8[MCC] Server was successfully joined.",
		].join("\n")
		const [signal] = connectionSignals(parseJournal(raw))

		expect(signal).toMatchObject({ kind: "disconnected", reason: undefined })
	})

	it("sees the client being stopped, which is also a reason it is not on its server", () => {
		const raw =
			"2026-09-06T10:46:22+0800 tjsx100 systemd[1525547]: Stopped open-mcc@abc.service - open-mcc-manager instance abc."
		const [signal] = connectionSignals(parseJournal(raw))

		expect(signal).toMatchObject({ kind: "stopped" })
	})

	it("reports the changes in the order they happened", () => {
		const signals = connectionSignals(parseJournal(REAL))

		expect(signals.map((signal) => signal.kind)).toEqual(["disconnected", "joined"])
	})

	it("notices the process changed, which is how a restart is told apart from a rejoin", () => {
		const signals = connectionSignals(parseJournal(REAL))

		expect(signals[0]?.pid).toBe("1689967")
		expect(signals[1]?.pid).toBe("1702654")
	})
})

const CURSOR =
	"s=c4186291247d41ed927aa92d3a547b68;i=f8f;b=67838491865a4df196b5ddc0a1368b45;m=42d4f57e5c;t=65ba7d85943a2;x=d8aaf1d0ab63dbdd"

const NOT_CURSORS = [
	{
		what: "a seqnum id one hex digit short",
		value:
			"s=c4186291247d41ed927aa92d3a547b6;i=f8f;b=67838491865a4df196b5ddc0a1368b45;m=42d4f57e5c;t=65ba7d85943a2;x=d8aaf1d0ab63dbdd",
	},
	{
		what: "a seqnum that is not hex",
		value:
			"s=c4186291247d41ed927aa92d3a547b68;i=zzz;b=67838491865a4df196b5ddc0a1368b45;m=42d4f57e5c;t=65ba7d85943a2;x=d8aaf1d0ab63dbdd",
	},
	{
		what: "a boot id one hex digit short",
		value:
			"s=c4186291247d41ed927aa92d3a547b68;i=f8f;b=67838491865a4df196b5ddc0a1368b4;m=42d4f57e5c;t=65ba7d85943a2;x=d8aaf1d0ab63dbdd",
	},
	{
		what: "an empty monotonic stamp",
		value:
			"s=c4186291247d41ed927aa92d3a547b68;i=f8f;b=67838491865a4df196b5ddc0a1368b45;m=;t=65ba7d85943a2;x=d8aaf1d0ab63dbdd",
	},
	{
		what: "a realtime stamp that is not hex",
		value:
			"s=c4186291247d41ed927aa92d3a547b68;i=f8f;b=67838491865a4df196b5ddc0a1368b45;m=42d4f57e5c;t=2026-09-06;x=d8aaf1d0ab63dbdd",
	},
	{
		what: "no hash field at all",
		value:
			"s=c4186291247d41ed927aa92d3a547b68;i=f8f;b=67838491865a4df196b5ddc0a1368b45;m=42d4f57e5c;t=65ba7d85943a2",
	},
] as const

describe("telling a journald cursor from anything else stored in its place", () => {
	it("accepts the cursor journalctl itself printed", () => {
		expect(isJournalCursor(CURSOR)).toBe(true)
	})

	it.each(NOT_CURSORS.map((each) => ({ ...each })))(
		"refuses $what, which differs from a real cursor in that field alone",
		({ value }) => {
			expect(isJournalCursor(value)).toBe(false)
		},
	)

	it("refuses the timestamps stored before cursors were", () => {
		expect(isJournalCursor("2026-09-06T06:16:10.000Z")).toBe(false)
		expect(isJournalCursor("2026-09-06 06:16:10 UTC")).toBe(false)
	})
})

describe("splitting a journal read from the position journalctl reported", () => {
	it("takes the cursor off the trailing note and leaves the entries alone", () => {
		const batch = journalBatch(`${REAL}\n-- cursor: ${CURSOR}\n`)

		expect(batch.cursor).toBe(CURSOR)
		expect(batch.lines).toHaveLength(3)
	})

	it("drops journalctl's other notes, which are not entries", () => {
		const batch = journalBatch(`-- Boot 0000 --\n${REAL}\n-- cursor: ${CURSOR}\n`)

		expect(batch.lines).toHaveLength(3)
	})

	it("reports no cursor when the read showed nothing", () => {
		const batch = journalBatch("-- No entries --\n")

		expect(batch).toEqual({ lines: [], cursor: undefined })
	})

	it("refuses a shown cursor that is not one, rather than spending it", () => {
		const batch = journalBatch(`${REAL}\n-- cursor: 2026-09-06T06:16:10.000Z\n`)

		expect(batch.cursor).toBeUndefined()
		expect(batch.lines).toHaveLength(3)
	})
})

describe("what the host says when it cannot use the position it was given", () => {
	it("recognises journalctl's own refusal", () => {
		expect(journalRefusedCursor("Failed to seek to cursor: Invalid argument\n")).toBe(true)
	})

	it("does not read a different journalctl failure as a refused cursor", () => {
		expect(journalRefusedCursor("Failed to add filter for units: Invalid argument\n")).toBe(false)
	})
})

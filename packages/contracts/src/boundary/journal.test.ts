import { describe, expect, it } from "vitest"
import { connectionSignals, parseJournal, parseJournalLine, stripColour } from "./journal"

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

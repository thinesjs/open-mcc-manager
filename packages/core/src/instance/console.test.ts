import { createFakeTransport, readerOver } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import { readConsole } from "./console"

const reading = async () => {
	const transport = createFakeTransport()
	const reader = await readerOver(transport)
	return { transport, reader }
}

describe("reading an instance's console", () => {
	it("bounds the journal read rather than streaming the whole unit history", async () => {
		const { transport, reader } = await reading()
		await readConsole(reader, "abc", 100)
		expect(transport.commands[0]).toContain("--lines 100")
		expect(transport.commands[0]).toContain("open-mcc@abc")
		reader.release()
	})

	it("reads the user journal, where the unit's log lives", async () => {
		const { transport, reader } = await reading()
		await readConsole(reader, "abc", 100)
		expect(transport.commands[0]).toContain("journalctl --user")
		reader.release()
	})

	it("refuses an unbounded or absurd line count", async () => {
		const { transport, reader } = await reading()
		await expect(readConsole(reader, "abc", 0)).rejects.toThrow()
		await expect(readConsole(reader, "abc", 10_000)).rejects.toThrow()
		expect(transport.commands).toEqual([])
		reader.release()
	})
})

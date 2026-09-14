import type { HostCheckReport } from "@open-mcc/contracts"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HostCheckList } from "./host-check-list"

const LINGER = "sudo loginctl enable-linger mcc"

const REPORT: HostCheckReport = {
	ready: false,
	checks: [
		{
			name: "reachable",
			outcome: "pass",
			detail: "Connected and the host key matched",
			command: null,
			hint: null,
		},
		{
			name: "lingering",
			outcome: "fail",
			detail: "Bots would stop when you log out.",
			command: LINGER,
			hint: null,
		},
		{
			name: "cgroups",
			outcome: "fail",
			detail: "This server's system is too old for Podman.",
			command: null,
			hint: "Podman needs cgroup v2.",
		},
	],
}

afterEach(cleanup)

describe("what an operator sees for each prerequisite", () => {
	it("shows each check's one sentence", () => {
		render(<HostCheckList report={REPORT} />)

		for (const check of REPORT.checks) expect(screen.getByText(check.detail)).toBeDefined()
	})

	it("shows the exact command, with a copy button that copies exactly it", async () => {
		const writeText = vi.fn(async (_value: string) => undefined)
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
		render(<HostCheckList report={REPORT} />)

		expect(screen.getByText(LINGER)).toBeDefined()
		fireEvent.click(screen.getByRole("button", { name: "Copy command" }))

		await waitFor(() => expect(writeText).toHaveBeenCalledWith(LINGER))
	})

	it("offers a copy button only where a command fixes the result", () => {
		render(<HostCheckList report={REPORT} />)

		expect(screen.getAllByRole("button", { name: "Copy command" })).toHaveLength(1)
	})

	it("keeps the detail in a tooltip, not inline and not in a native title", async () => {
		render(<HostCheckList report={REPORT} />)

		expect(screen.queryByText("Podman needs cgroup v2.")).toBeNull()
		expect(document.querySelector("[title]")).toBeNull()

		fireEvent.focus(screen.getByText("This server's system is too old for Podman."))

		await waitFor(() => expect(screen.getByText("Podman needs cgroup v2.")).toBeDefined())
	})
})

import type { HostCheckReport } from "@open-mcc/contracts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { EnrollHostSteps } from "./enroll-host-steps"

class UnmeasuredResizeObserver {
	observe = () => undefined
	unobserve = () => undefined
	disconnect = () => undefined
}

beforeAll(() => {
	vi.stubGlobal("ResizeObserver", UnmeasuredResizeObserver)
})

afterAll(() => {
	vi.unstubAllGlobals()
})

const check = vi.fn()
const enroll = vi.fn()

const KEYS = [
	{ id: "key-1", name: "deploy", publicKey: "ssh-ed25519 AAAAdeploy deploy" },
	{ id: "key-2", name: "spare", publicKey: "ssh-ed25519 AAAAspare spare" },
]

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: ReactNode }) => <a href="/ssh-keys">{children}</a>,
}))

vi.mock("~/lib/trpc", () => ({
	useTRPC: () => ({
		sshKey: {
			list: { queryOptions: () => ({ queryKey: ["sshKey", "list"], queryFn: async () => KEYS }) },
		},
		host: {
			check: { mutationOptions: () => ({ mutationFn: check }) },
			enroll: { mutationOptions: () => ({ mutationFn: enroll }) },
			list: { queryKey: () => ["host", "list"] },
		},
	}),
}))

afterEach(() => {
	cleanup()
	check.mockReset()
	enroll.mockReset()
})

const FINGERPRINT = `SHA256:${"A".repeat(43)}`

const OTHER_FINGERPRINT = `SHA256:${"B".repeat(43)}`

const READY: HostCheckReport = {
	ready: true,
	checks: [
		{
			name: "reachable",
			outcome: "pass",
			detail: "Connected and the host key matched",
			command: null,
			hint: null,
		},
	],
}

const NOT_READY: HostCheckReport = {
	ready: false,
	checks: [
		{
			name: "lingering",
			outcome: "fail",
			detail: "Bots would stop when you log out.",
			command: "sudo loginctl enable-linger mcc",
			hint: null,
		},
	],
}

const mount = () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	})
	render(
		<QueryClientProvider client={client}>
			<EnrollHostSteps onEnrolled={() => undefined} />
		</QueryClientProvider>,
	)
}

const button = (name: string) => screen.getByRole("button", { name })

const isDisabled = (name: string): boolean => button(name).hasAttribute("disabled")

const next = () => fireEvent.click(button("Continue"))

const back = () => fireEvent.click(button("Back"))

const type = (label: string, value: string) =>
	fireEvent.change(screen.getByLabelText(label), { target: { value } })

const showsKey = (name: string): Promise<boolean> =>
	waitFor(() => expect(screen.getByRole("combobox").textContent).toContain(name), {
		timeout: 300,
	}).then(
		() => true,
		() => false,
	)

const chooseKey = async (name: string) => {
	await screen.findByRole("combobox")
	for (let attempt = 0; attempt < 10 && !(await showsKey(name)); attempt += 1) {
		if (screen.queryByRole("option", { name }) === null) {
			fireEvent.click(screen.getByRole("combobox"))
		}
		fireEvent.click(await screen.findByRole("option", { name }))
	}
	expect(screen.getByRole("combobox").textContent).toContain(name)
}

const reachAddress = async () => {
	mount()
	await chooseKey("deploy")
	next()
}

const fillAddress = () => {
	type("Name", "vps")
	type("Hostname or IP", "vps.example.com")
	type("Port", "22")
	type("Server username", "mcc")
}

const reachVerify = async () => {
	await reachAddress()
	fillAddress()
	next()
	next()
	type("Server fingerprint", FINGERPRINT)
}

const runCheck = async (report: HostCheckReport) => {
	check.mockResolvedValueOnce(report)
	fireEvent.click(button("Check host"))
	await screen.findByText(report.checks[0]?.detail ?? "")
}

describe("leaving the address step", () => {
	it.each(["0", "65536", "22a", "", "-1", "1.5"])("blocks Continue on port '%s'", async (port) => {
		await reachAddress()
		fillAddress()

		type("Port", port)

		expect(isDisabled("Continue")).toBe(true)
	})

	it.each(["1", "22", "65535"])("allows Continue on port %s", async (port) => {
		await reachAddress()
		fillAddress()

		type("Port", port)

		expect(isDisabled("Continue")).toBe(false)
	})

	it("blocks Continue without an account", async () => {
		await reachAddress()
		fillAddress()

		type("Server username", "")

		expect(isDisabled("Continue")).toBe(true)
	})
})

describe("enrolling only a host whose check came back ready", () => {
	it("keeps Enroll disabled until a check comes back ready", async () => {
		await reachVerify()

		expect(isDisabled("Enroll host")).toBe(true)

		await runCheck(READY)

		expect(isDisabled("Enroll host")).toBe(false)
	})

	it("keeps Enroll disabled when the check is not ready", async () => {
		await reachVerify()

		await runCheck(NOT_READY)

		expect(isDisabled("Enroll host")).toBe(true)
	})

	it("checks exactly the key, address, port, account and fingerprint entered", async () => {
		await reachVerify()

		await runCheck(READY)

		expect(check.mock.calls[0]?.[0]).toEqual({
			sshKeyId: "key-1",
			hostname: "vps.example.com",
			port: 22,
			username: "mcc",
			expectedFingerprint: FINGERPRINT,
		})
	})

	it("offers no check for a fingerprint that is not a SHA256 fingerprint", async () => {
		await reachVerify()

		type("Server fingerprint", "SHA256:short")

		expect(isDisabled("Check host")).toBe(true)
		expect(isDisabled("Enroll host")).toBe(true)
	})

	it.each([
		{
			input: "fingerprint",
			edit: async () => type("Server fingerprint", OTHER_FINGERPRINT),
		},
		{
			input: "address",
			edit: async () => {
				back()
				back()
				type("Hostname or IP", "other.example.com")
				next()
				next()
			},
		},
		{
			input: "port",
			edit: async () => {
				back()
				back()
				type("Port", "2222")
				next()
				next()
			},
		},
		{
			input: "account",
			edit: async () => {
				back()
				back()
				type("Server username", "bots")
				next()
				next()
			},
		},
		{
			input: "key",
			edit: async () => {
				back()
				back()
				back()
				await chooseKey("spare")
				next()
				next()
				next()
			},
		},
	])("clears the check result when the $input changes", async ({ edit }) => {
		await reachVerify()
		await runCheck(READY)

		await edit()

		expect(screen.queryByText("Connected and the host key matched")).toBeNull()
		expect(isDisabled("Enroll host")).toBe(true)
	})

	it("does not count a check that comes back after the inputs changed", async () => {
		await reachVerify()
		let finish: (report: HostCheckReport) => void = () => undefined
		check.mockImplementationOnce(
			() =>
				new Promise<HostCheckReport>((resolve) => {
					finish = resolve
				}),
		)

		fireEvent.click(button("Check host"))
		type("Server fingerprint", OTHER_FINGERPRINT)
		await act(async () => finish(READY))

		expect(isDisabled("Enroll host")).toBe(true)
	})
})

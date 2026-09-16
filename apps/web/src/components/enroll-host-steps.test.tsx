import {
	ADDRESS_PROBE_MESSAGES,
	ADDRESS_PROBE_OUTCOMES,
	EXPRESS_WARNING,
	EXPRESS_WARNING_TITLE,
	type HostCheckReport,
	hostSetupScript,
} from "@open-mcc/contracts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { EnrollHostSteps, STALE_COMMAND_NOTICE } from "./enroll-host-steps"

class UnmeasuredResizeObserver {
	observe = () => undefined
	unobserve = () => undefined
	disconnect = () => undefined
}

const writeText = vi.fn(async () => undefined)

beforeAll(() => {
	vi.stubGlobal("ResizeObserver", UnmeasuredResizeObserver)
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
})

afterAll(() => {
	vi.unstubAllGlobals()
})

const check = vi.fn()
const enroll = vi.fn()
const probe = vi.fn()
const readHostKey = vi.fn()
const expressInstall = vi.fn()

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
			probeAddress: { mutationOptions: () => ({ mutationFn: probe }) },
			readHostKey: { mutationOptions: () => ({ mutationFn: readHostKey }) },
			expressInstall: { mutationOptions: () => ({ mutationFn: expressInstall }) },
			list: { queryKey: () => ["host", "list"] },
		},
	}),
}))

afterEach(() => {
	cleanup()
	check.mockReset()
	enroll.mockReset()
	probe.mockReset()
	readHostKey.mockReset()
	expressInstall.mockReset()
	writeText.mockClear()
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

const KEY_REFUSED: HostCheckReport = {
	ready: false,
	checks: [
		{
			name: "reachable",
			outcome: "fail",
			detail: "The server did not accept this SSH key",
			command: null,
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
}

const reachAccount = async () => {
	await reachAddress()
	fillAddress()
	next()
}

const reachPrepare = async () => {
	await reachAccount()
	next()
}

const reachVerify = async () => {
	await reachPrepare()
	next()
	type("Server fingerprint", FINGERPRINT)
}

const runCheck = async (report: HostCheckReport) => {
	check.mockResolvedValueOnce(report)
	fireEvent.click(button("Check host"))
	await screen.findByText(report.checks[0]?.detail ?? "")
}

const runProbe = async (outcome: (typeof ADDRESS_PROBE_OUTCOMES)[number]) => {
	probe.mockResolvedValueOnce({ outcome })
	fireEvent.click(button("Test connection"))
	await screen.findByText(ADDRESS_PROBE_MESSAGES[outcome])
}

const chooseAccountMode = (value: string) => {
	const option = screen.getAllByRole("radio").find((radio) => radio.getAttribute("value") === value)

	expect(option).toBeDefined()
	if (option) fireEvent.click(option)
}

const prepareStep = (): HTMLElement => {
	const heading = screen.getAllByText("Prepare the host").at(-1)
	const panel = heading?.closest("div.space-y-4")

	expect(panel).toBeInstanceOf(HTMLElement)
	return panel instanceof HTMLElement ? panel : document.body
}

const copySetupCommand = async () => {
	writeText.mockClear()
	const copies = screen.getAllByRole("button", { name: /setup command/i })
	const latest = copies.at(-1)

	expect(latest).toBeDefined()
	if (latest) fireEvent.click(latest)
	await waitFor(() => expect(writeText).toHaveBeenCalled())
	await act(async () => undefined)
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
})

describe("testing the address before anything is run on the server", () => {
	it("asks only where the server is, with no key, account or fingerprint", async () => {
		await reachAddress()
		fillAddress()

		await runProbe("answered")

		expect(probe.mock.calls[0]?.[0]).toEqual({ hostname: "vps.example.com", port: 22 })
	})

	it("offers the test before a key has been authorised or a fingerprint read", async () => {
		await reachAddress()
		fillAddress()

		expect(isDisabled("Test connection")).toBe(false)
		expect(screen.queryByLabelText("Server fingerprint")).toBeNull()
	})

	it("offers no test until there is an address to test", async () => {
		await reachAddress()

		expect(isDisabled("Test connection")).toBe(true)
	})

	it.each(ADDRESS_PROBE_OUTCOMES)("says what happened on %s", async (outcome) => {
		await reachAddress()
		fillAddress()

		await runProbe(outcome)

		expect(screen.getByText(ADDRESS_PROBE_MESSAGES[outcome])).toBeDefined()
	})

	it("does not claim the host is ready when the address answers", async () => {
		await reachAddress()
		fillAddress()

		await runProbe("answered")

		expect(screen.getByText(ADDRESS_PROBE_MESSAGES.answered).textContent).toContain(
			"checked at the end",
		)
	})

	it("stays optional, so a failed test does not block the wizard", async () => {
		await reachAddress()
		fillAddress()

		await runProbe("refused")

		expect(isDisabled("Continue")).toBe(false)
	})

	it("drops the result once the address changes", async () => {
		await reachAddress()
		fillAddress()
		await runProbe("answered")

		type("Hostname or IP", "other.example.com")

		expect(screen.queryByText(ADDRESS_PROBE_MESSAGES.answered)).toBeNull()
	})
})

describe("choosing the account the bots run as", () => {
	it.each(["", "My Account", "9bots", "OPENMCC_SETUP", "pi'; rm -rf /"])(
		"blocks Continue on the account name '%s'",
		async (name) => {
			await reachAccount()

			type("Account name", name)

			expect(isDisabled("Continue")).toBe(true)
			expect(
				screen.getByText("Use lowercase letters, digits, - and _, starting with a letter or _."),
			).toBeDefined()
		},
	)

	it("allows a name useradd would take", async () => {
		await reachAccount()

		type("Account name", "bots-1")

		expect(isDisabled("Continue")).toBe(false)
	})

	it("offers to create one by default, and carries the default name into the command", async () => {
		await reachPrepare()

		expect(screen.getByText("Creates the account mcc if it is missing")).toBeDefined()
		expect(screen.getByText("Authorises the key deploy for mcc")).toBeDefined()
	})

	it("leaves the account alone when the operator already has one", async () => {
		await reachAccount()

		chooseAccountMode("existing")
		next()

		expect(screen.queryByText("Creates the account mcc if it is missing")).toBeNull()
		expect(screen.getByText("Authorises the key deploy for mcc")).toBeDefined()
	})

	it("carries the account the operator typed into the command", async () => {
		await reachAccount()

		type("Account name", "bots")
		next()

		expect(screen.getByText("Creates the account bots if it is missing")).toBeDefined()
	})
})

describe("changing an input after the setup command was copied", () => {
	it("says the copied command must be run again when the key changes", async () => {
		await reachPrepare()
		await copySetupCommand()

		back()
		back()
		back()
		await chooseKey("spare")

		expect(screen.getByText(STALE_COMMAND_NOTICE)).toBeDefined()
	})

	it("says it when the account changes too", async () => {
		await reachPrepare()
		await copySetupCommand()

		back()
		type("Account name", "bots")

		expect(screen.getByText(STALE_COMMAND_NOTICE)).toBeDefined()
	})

	it("says it on the step that shows the command too", async () => {
		await reachPrepare()
		await copySetupCommand()
		back()
		type("Account name", "bots")
		next()

		expect(within(prepareStep()).getByText(STALE_COMMAND_NOTICE)).toBeDefined()
	})

	it("says nothing on that step while the copied command is still the one shown", async () => {
		await reachPrepare()
		await copySetupCommand()

		expect(within(prepareStep()).queryByText(STALE_COMMAND_NOTICE)).toBeNull()
	})

	it("says nothing when no command has been copied", async () => {
		await reachPrepare()

		back()
		back()
		back()
		await chooseKey("spare")

		expect(screen.queryByText(STALE_COMMAND_NOTICE)).toBeNull()
	})

	it("stops saying it once the new command is copied", async () => {
		await reachPrepare()
		await copySetupCommand()
		back()
		type("Account name", "bots")
		next()

		await copySetupCommand()
		back()

		expect(screen.queryByText(STALE_COMMAND_NOTICE)).toBeNull()
	})

	it("stops saying it when the change is undone", async () => {
		await reachPrepare()
		await copySetupCommand()
		back()
		type("Account name", "bots")
		expect(screen.getByText(STALE_COMMAND_NOTICE)).toBeDefined()

		type("Account name", "mcc")

		expect(screen.queryByText(STALE_COMMAND_NOTICE)).toBeNull()
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

	it("shows the reason the server gave, rather than a failure of its own", async () => {
		await reachVerify()

		await runCheck(KEY_REFUSED)

		expect(screen.getByText("The server did not accept this SSH key")).toBeDefined()
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
				back()
				type("Hostname or IP", "other.example.com")
				next()
				next()
				next()
			},
		},
		{
			input: "port",
			edit: async () => {
				back()
				back()
				back()
				type("Port", "2222")
				next()
				next()
				next()
			},
		},
		{
			input: "account",
			edit: async () => {
				back()
				back()
				type("Account name", "bots")
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
				back()
				await chooseKey("spare")
				next()
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
		await waitFor(() => expect(check).toHaveBeenCalledTimes(1))
		type("Server fingerprint", OTHER_FINGERPRINT)
		await act(async () => finish(READY))
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20))
		})

		expect(isDisabled("Enroll host")).toBe(true)
	})
})

const chooseExpress = () => fireEvent.click(screen.getByRole("radio", { name: /Set it up for me/ }))

describe("choosing between running the setup yourself and having it run for you", () => {
	it("offers the choice at the top, before anything else is asked", async () => {
		mount()

		expect(screen.getByRole("radio", { name: /Set it up for me/ })).toBeTruthy()
		expect(screen.getByRole("radio", { name: /I will run the command/ })).toBeTruthy()
	})

	it("says what the step is asking once, on the choice itself, not above it as well", async () => {
		mount()

		const heading = screen.getByText("How this server gets set up")

		expect(heading.tagName).toBe("LEGEND")
		expect(heading.className.split(" ")).not.toContain("sr-only")
	})

	it("starts on the path that needs no root, so nothing escalates by default", async () => {
		mount()

		expect(screen.queryByText(EXPRESS_WARNING)).toBeNull()
		expect(screen.queryByText(EXPRESS_WARNING_TITLE)).toBeNull()
	})

	it("puts the warning in front of the operator the moment Express is chosen", async () => {
		mount()

		chooseExpress()

		expect(screen.getByText(EXPRESS_WARNING_TITLE)).toBeTruthy()
		expect(screen.getByText(EXPRESS_WARNING)).toBeTruthy()
	})

	it("says it needs root, that commands run as root, and that a critical machine is the wrong place", () => {
		expect(EXPRESS_WARNING).toContain("root account")
		expect(EXPRESS_WARNING).toContain("as root on your server")
		expect(EXPRESS_WARNING).toContain("critical machine")
	})

	it("takes the warning away again when the operator goes back to running it themselves", async () => {
		mount()
		chooseExpress()

		fireEvent.click(screen.getByRole("radio", { name: /I will run the command/ }))

		expect(screen.queryByText(EXPRESS_WARNING)).toBeNull()
	})

	it("shows the command to copy on the manual path, and no root credential field", async () => {
		await reachPrepare()

		expect(screen.getByText("Setup command")).toBeTruthy()
		expect(screen.queryByLabelText("Root password")).toBeNull()
	})

	it("asks for a root credential on the Express path, and shows nothing to copy", async () => {
		mount()
		chooseExpress()
		await chooseKey("deploy")
		next()
		fillAddress()
		next()
		next()

		expect(screen.getByLabelText("Root password")).toBeTruthy()
		expect(screen.queryByText("Setup command")).toBeNull()
	})

	it("returns the operator to the copyable command when Express hands them back", async () => {
		mount()
		chooseExpress()
		await chooseKey("deploy")
		next()
		fillAddress()
		next()
		next()
		readHostKey.mockResolvedValue({ fingerprint: FINGERPRINT, algorithm: "ssh-ed25519" })
		type("Root password", "a-root-password")
		fireEvent.click(button("Read host key"))
		await screen.findByText(FINGERPRINT)
		fireEvent.click(await screen.findByRole("button", { name: /This matches/ }))
		expressInstall.mockResolvedValue({ outcome: "refused" })
		fireEvent.click(button("Set up the server"))

		fireEvent.click(await screen.findByRole("button", { name: "Run the command myself instead" }))

		expect(await screen.findByText("Setup command")).toBeTruthy()
	})

	it("asks the server for the very command the manual path puts on screen", async () => {
		mount()
		chooseExpress()
		await chooseKey("deploy")
		next()
		fillAddress()
		next()
		type("Account name", "bots")
		fireEvent.click(screen.getByRole("radio", { name: /I already have one/ }))
		next()
		readHostKey.mockResolvedValue({ fingerprint: FINGERPRINT, algorithm: "ssh-ed25519" })
		type("Root password", "a-root-password")
		fireEvent.click(button("Read host key"))
		await screen.findByText(FINGERPRINT)
		fireEvent.click(await screen.findByRole("button", { name: /This matches/ }))
		expressInstall.mockResolvedValue({ outcome: "refused" })
		fireEvent.click(button("Set up the server"))
		await waitFor(() => expect(expressInstall).toHaveBeenCalledTimes(1))
		const sent = expressInstall.mock.calls[0]?.[0]

		fireEvent.click(await screen.findByRole("button", { name: "Run the command myself instead" }))
		await screen.findByText("Setup command")
		const shown = document.querySelector("code")?.textContent ?? ""

		expect(sent.username).toBe("bots")
		expect(sent.createAccount).toBe(false)
		expect(sent.sshKeyId).toBe("key-1")
		expect(shown).toBe(hostSetupScript(sent.username, KEYS[0]?.publicKey ?? "", sent.createAccount))
		expect(shown).toContain("account='bots'")
	})

	it("carries the confirmed fingerprint into the verify step rather than asking for it again", async () => {
		mount()
		chooseExpress()
		await chooseKey("deploy")
		next()
		fillAddress()
		next()
		next()
		readHostKey.mockResolvedValue({ fingerprint: FINGERPRINT, algorithm: "ssh-ed25519" })
		type("Root password", "a-root-password")
		fireEvent.click(button("Read host key"))
		await screen.findByText(FINGERPRINT)
		fireEvent.click(await screen.findByRole("button", { name: /This matches/ }))
		expressInstall.mockResolvedValue({ outcome: "ready", fingerprint: FINGERPRINT })

		fireEvent.click(button("Set up the server"))

		const field = await screen.findByLabelText("Server fingerprint")
		if (!(field instanceof HTMLInputElement)) throw new Error("expected an input")
		expect(field.value).toBe(FINGERPRINT)
	})
})

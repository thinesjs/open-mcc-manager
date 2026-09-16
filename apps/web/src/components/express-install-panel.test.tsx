import {
	EXPRESS_HOST_KEY_CONFIRMATION,
	EXPRESS_KEY_MISMATCH_MESSAGE,
	EXPRESS_KEY_UNREADABLE_MESSAGE,
	EXPRESS_MANUAL_FALLBACK,
	EXPRESS_REFUSED_MESSAGE,
	type ExpressInstallResult,
	LOCKED_KEEPS_PASSWORD,
} from "@open-mcc/contracts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ExpressInstallPanel } from "./express-install-panel"

class UnmeasuredResizeObserver {
	observe = () => undefined
	unobserve = () => undefined
	disconnect = () => undefined
}

beforeAll(() => {
	vi.stubGlobal("ResizeObserver", UnmeasuredResizeObserver)
})

const readHostKey = vi.fn()
const expressInstall = vi.fn()

vi.mock("~/lib/trpc", () => ({
	useTRPC: () => ({
		host: {
			readHostKey: { mutationOptions: () => ({ mutationFn: readHostKey }) },
			expressInstall: { mutationOptions: () => ({ mutationFn: expressInstall }) },
		},
	}),
}))

afterEach(() => {
	cleanup()
	readHostKey.mockReset()
	expressInstall.mockReset()
})

const FINGERPRINT = `SHA256:${"A".repeat(43)}`

const ROOT_PASSWORD = "root-secret-1234"

const onReady = vi.fn()
const onManual = vi.fn()

const Wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider
		client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
	>
		{children}
	</QueryClientProvider>
)

const mount = () => {
	onReady.mockReset()
	onManual.mockReset()
	render(
		<Wrapper>
			<ExpressInstallPanel
				hostname="198.51.100.4"
				port={22}
				username="mcc"
				sshKeyId="key-1"
				createAccount
				onReady={onReady}
				onManual={onManual}
			/>
		</Wrapper>,
	)
}

const passwordField = (): HTMLInputElement => {
	const field = screen.getByLabelText("Root password")
	if (!(field instanceof HTMLInputElement)) throw new Error("expected a password input")
	return field
}

const isDisabled = (name: string): boolean =>
	screen.getByRole("button", { name }).hasAttribute("disabled")

const typePassword = (value: string): void => {
	fireEvent.change(passwordField(), { target: { value } })
}

const readTheKey = async (): Promise<void> => {
	readHostKey.mockResolvedValue({ fingerprint: FINGERPRINT, algorithm: "ssh-ed25519" })
	fireEvent.click(screen.getByRole("button", { name: "Read host key" }))
	await screen.findByText(FINGERPRINT)
}

const confirmTheKey = (): void => {
	fireEvent.click(screen.getByRole("button", { name: /This matches/ }))
}

const setUp = (): void => {
	fireEvent.click(screen.getByRole("button", { name: "Set up the server" }))
}

describe("holding the root credential until the host has proved who it is", () => {
	it("cannot be set going before the host key is confirmed", async () => {
		mount()
		typePassword(ROOT_PASSWORD)

		expect(isDisabled("Set up the server")).toBe(true)

		await readTheKey()

		expect(isDisabled("Set up the server")).toBe(true)
	})

	it("sends nothing when the operator tries to start before confirming", async () => {
		mount()
		typePassword(ROOT_PASSWORD)
		await readTheKey()

		setUp()

		await waitFor(() => expect(isDisabled("Set up the server")).toBe(true))
		expect(expressInstall).not.toHaveBeenCalled()
	})

	it("reads the host key without offering any credential at all", async () => {
		mount()
		typePassword(ROOT_PASSWORD)

		await readTheKey()

		expect(readHostKey.mock.calls[0]?.[0]).toEqual({ hostname: "198.51.100.4", port: 22 })
		expect(JSON.stringify(readHostKey.mock.calls)).not.toContain(ROOT_PASSWORD)
		expect(expressInstall).not.toHaveBeenCalled()
	})

	it("says what confirming protects against, and that not checking is a guess", async () => {
		mount()

		await readTheKey()

		expect(screen.getByText(EXPRESS_HOST_KEY_CONFIRMATION)).toBeTruthy()
	})

	it("sends the credential only after the operator confirmed, and against that same key", async () => {
		mount()
		typePassword(ROOT_PASSWORD)
		await readTheKey()
		confirmTheKey()
		expressInstall.mockResolvedValue({ outcome: "ready", fingerprint: FINGERPRINT })

		setUp()

		await waitFor(() => expect(expressInstall).toHaveBeenCalledTimes(1))
		expect(expressInstall.mock.calls[0]?.[0]).toEqual({
			hostname: "198.51.100.4",
			port: 22,
			username: "mcc",
			sshKeyId: "key-1",
			createAccount: true,
			expectedFingerprint: FINGERPRINT,
			unlock: false,
			credential: { kind: "password", password: ROOT_PASSWORD },
		})
	})

	it("stops trusting a key the operator has not re-confirmed after a fresh read", async () => {
		mount()
		typePassword(ROOT_PASSWORD)
		await readTheKey()
		confirmTheKey()

		fireEvent.click(screen.getByRole("button", { name: "Read host key" }))

		await waitFor(() => expect(isDisabled("Set up the server")).toBe(true))
	})

	it("forgets the credential once the server is set up", async () => {
		mount()
		typePassword(ROOT_PASSWORD)
		await readTheKey()
		confirmTheKey()
		expressInstall.mockResolvedValue({ outcome: "ready", fingerprint: FINGERPRINT })

		setUp()

		await waitFor(() => expect(onReady).toHaveBeenCalledWith(FINGERPRINT))
		expect(passwordField().value).toBe("")
	})

	it("offers a root key as an alternative to a password", async () => {
		mount()
		fireEvent.click(screen.getByRole("radio", { name: /SSH key/ }))
		fireEvent.change(screen.getByLabelText("Root private key"), {
			target: { value: "PEM MATERIAL" },
		})
		await readTheKey()
		confirmTheKey()
		expressInstall.mockResolvedValue({ outcome: "ready", fingerprint: FINGERPRINT })

		setUp()

		await waitFor(() => expect(expressInstall).toHaveBeenCalledTimes(1))
		expect(expressInstall.mock.calls[0]?.[0]?.credential).toEqual({
			kind: "key",
			privateKey: "PEM MATERIAL",
		})
	})
})

const reachOutcome = async (result: ExpressInstallResult): Promise<void> => {
	mount()
	typePassword(ROOT_PASSWORD)
	await readTheKey()
	confirmTheKey()
	expressInstall.mockResolvedValue(result)
	setUp()
	await waitFor(() => expect(expressInstall).toHaveBeenCalled())
}

describe("where each way this can fail leaves the operator", () => {
	it("asks on screen about a locked account, since nobody could answer on the host", async () => {
		await reachOutcome({ outcome: "locked", account: "mcc", keepsPassword: true })

		expect(await screen.findByText(new RegExp(LOCKED_KEEPS_PASSWORD))).toBeTruthy()
		expect(screen.getByRole("button", { name: /Unlock mcc and run the setup again/ })).toBeTruthy()
	})

	it("runs the same setup again with the answer once the operator gives it", async () => {
		await reachOutcome({ outcome: "locked", account: "mcc", keepsPassword: false })
		expressInstall.mockResolvedValue({ outcome: "ready", fingerprint: FINGERPRINT })

		fireEvent.click(screen.getByRole("button", { name: /Unlock mcc and run the setup again/ }))

		await waitFor(() => expect(expressInstall).toHaveBeenCalledTimes(2))
		expect(expressInstall.mock.calls[1]?.[0]?.unlock).toBe(true)
		expect(expressInstall.mock.calls[1]?.[0]?.credential).toEqual({
			kind: "password",
			password: ROOT_PASSWORD,
		})
	})

	it("says plainly that the credential was refused", async () => {
		await reachOutcome({ outcome: "refused" })

		expect(await screen.findByText(EXPRESS_REFUSED_MESSAGE)).toBeTruthy()
	})

	it("says plainly that the address could not be reached", async () => {
		await reachOutcome({ outcome: "unreachable", reason: "The server refused the connection" })

		expect(await screen.findByText("The server refused the connection")).toBeTruthy()
	})

	it("says plainly that the key changed under it", async () => {
		await reachOutcome({ outcome: "key-mismatch" })

		expect(await screen.findByText(EXPRESS_KEY_MISMATCH_MESSAGE)).toBeTruthy()
	})

	it("hands back what the script said when the script itself stopped", async () => {
		await reachOutcome({
			outcome: "script-failed",
			reason: "This distribution isn't supported yet.",
		})

		expect(await screen.findByText("This distribution isn't supported yet.")).toBeTruthy()
	})

	it("blames the key rather than the server, and leaves the pasted key where it is", async () => {
		mount()
		fireEvent.click(screen.getByRole("radio", { name: /SSH key/ }))
		fireEvent.change(screen.getByLabelText("Root private key"), {
			target: { value: "PEM MATERIAL" },
		})
		await readTheKey()
		confirmTheKey()
		expressInstall.mockResolvedValue({ outcome: "credential-unreadable" })
		setUp()

		expect(await screen.findByText(EXPRESS_KEY_UNREADABLE_MESSAGE)).toBeTruthy()
		const field = screen.getByLabelText("Root private key")
		if (!(field instanceof HTMLTextAreaElement)) throw new Error("expected a textarea")
		expect(field.value).toBe("PEM MATERIAL")
		expect(screen.queryByRole("button", { name: EXPRESS_MANUAL_FALLBACK })).toBeNull()
	})

	it("always leaves a way out to the command an operator can run themselves", async () => {
		await reachOutcome({ outcome: "refused" })

		fireEvent.click(await screen.findByRole("button", { name: EXPRESS_MANUAL_FALLBACK }))

		expect(onManual).toHaveBeenCalledTimes(1)
	})

	it("offers that way out of a locked account too", async () => {
		await reachOutcome({ outcome: "locked", account: "mcc", keepsPassword: true })

		fireEvent.click(await screen.findByRole("button", { name: EXPRESS_MANUAL_FALLBACK }))

		expect(onManual).toHaveBeenCalledTimes(1)
	})
})

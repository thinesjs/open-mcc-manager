import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RetrustHostKey } from "./retrust-host-key"

const retrust = vi.fn()

vi.mock("~/lib/trpc", () => ({
	useTRPC: () => ({
		host: {
			retrustHostKey: { mutationOptions: () => ({ mutationFn: retrust }) },
			list: { queryKey: () => ["host", "list"] },
		},
	}),
}))

afterEach(() => {
	cleanup()
	retrust.mockReset()
})

const FIRST = "SHA256:firstIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrst"
const SECOND = "SHA256:secondJKLMNOPQRSTUVWXYZabcdefghijklmnopqrst"

const mount = (role: "owner" | "operator" | "viewer" | undefined, disabled = false) => {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
	render(
		<QueryClientProvider client={client}>
			<RetrustHostKey hostId="host-1" hostName="kitchen-pi" role={role} disabled={disabled} />
		</QueryClientProvider>,
	)
}

const opener = () => screen.queryByRole("button", { name: "Change fingerprint" })
const fingerprintInput = () => screen.getByLabelText("New fingerprint")
const continueButton = () => screen.getByRole("button", { name: "Continue" })
const trustButton = () => screen.getByRole("button", { name: "Trust fingerprint" })

const enter = (value: string) => {
	fireEvent.change(fingerprintInput(), { target: { value } })
}

describe("who is offered the change", () => {
	it.each(["operator", "viewer", undefined] as const)("offers a %s nothing to press", (role) => {
		mount(role)

		expect(opener()).toBeNull()
	})

	it("offers an owner the change", () => {
		mount("owner")

		expect(opener()).not.toBeNull()
	})

	it("holds the change back while the server is busy", () => {
		mount("owner", true)

		expect(opener()?.hasAttribute("disabled")).toBe(true)
	})
})

describe("trusting a new fingerprint", () => {
	it("shows the exact fingerprint before trusting it, and trusts only that", async () => {
		retrust.mockResolvedValue({ id: "host-1" })
		mount("owner")

		fireEvent.click(opener() ?? document.body)
		enter(FIRST)
		fireEvent.click(continueButton())

		expect(screen.getByText(FIRST)).toBeDefined()
		expect(retrust).not.toHaveBeenCalled()

		fireEvent.click(trustButton())

		await waitFor(() =>
			expect(retrust.mock.calls[0]?.[0]).toEqual({
				hostId: "host-1",
				hostKeyFingerprint: FIRST,
				hostKeyAlgorithm: "ssh-ed25519",
			}),
		)
	})

	it("will not go on with something that is not a fingerprint", () => {
		mount("owner")

		fireEvent.click(opener() ?? document.body)
		enter("SHA256:short")

		expect(continueButton().hasAttribute("disabled")).toBe(true)
		expect(screen.queryByRole("button", { name: "Trust fingerprint" })).toBeNull()
	})

	it("trusts the corrected value after going back, never the first one shown", async () => {
		retrust.mockResolvedValue({ id: "host-1" })
		mount("owner")

		fireEvent.click(opener() ?? document.body)
		enter(FIRST)
		fireEvent.click(continueButton())
		fireEvent.click(screen.getByRole("button", { name: "Back" }))
		enter(SECOND)
		fireEvent.click(continueButton())

		expect(screen.getByText(SECOND)).toBeDefined()
		expect(screen.queryByText(FIRST)).toBeNull()
		fireEvent.click(trustButton())

		await waitFor(() => expect(retrust).toHaveBeenCalledTimes(1))
		expect(retrust.mock.calls[0]?.[0]).toMatchObject({ hostKeyFingerprint: SECOND })
	})

	it("ignores the spaces a paste brings along, and shows what it will send", async () => {
		retrust.mockResolvedValue({ id: "host-1" })
		mount("owner")

		fireEvent.click(opener() ?? document.body)
		enter(`  ${FIRST}\n`)
		fireEvent.click(continueButton())

		expect(screen.getByText(FIRST)).toBeDefined()
		fireEvent.click(trustButton())

		await waitFor(() =>
			expect(retrust.mock.calls[0]?.[0]).toMatchObject({ hostKeyFingerprint: FIRST }),
		)
	})

	it("says why it failed in local copy, never in the server's own words", async () => {
		retrust.mockRejectedValue(
			Object.assign(new Error(`Host host-1 cannot be re-trusted ${FIRST}`), {
				data: { errorCode: "HOST_PROVISIONING_IN_PROGRESS" },
			}),
		)
		mount("owner")

		fireEvent.click(opener() ?? document.body)
		enter(FIRST)
		fireEvent.click(continueButton())
		fireEvent.click(trustButton())

		await waitFor(() => expect(screen.getByText(/already in progress/)).toBeDefined())
		expect(screen.queryByText(/cannot be re-trusted/)).toBeNull()
	})
})

import type { SelfHostPublicOffer } from "@open-mcc/contracts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SelfHostCard, shouldOfferSelfHost } from "./self-host-card"

const adopt = vi.fn()
const provision = vi.fn()

vi.mock("~/lib/trpc", () => ({
	useTRPC: () => ({
		selfHost: {
			adopt: { mutationOptions: () => ({ mutationFn: adopt }) },
			offer: { queryKey: () => ["selfHost", "offer"] },
		},
		host: {
			provision: { mutationOptions: () => ({ mutationFn: provision }) },
			list: { queryKey: () => ["host", "list"] },
		},
	}),
}))

afterEach(() => {
	cleanup()
	adopt.mockReset()
	provision.mockReset()
})

const OFFER: SelfHostPublicOffer = {
	name: "kitchen-pi",
	hostname: "host.docker.internal",
	port: 22,
	username: "mcc",
	reach: "proven",
	systemd: true,
	linger: true,
}

const mount = (overrides: Partial<SelfHostPublicOffer> = {}, onAdded = vi.fn()) => {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
	render(
		<QueryClientProvider client={client}>
			<SelfHostCard offer={{ ...OFFER, ...overrides }} onAdded={onAdded} />
		</QueryClientProvider>,
	)
	return { onAdded }
}

const addButton = () => screen.queryByRole("button", { name: "Add this machine" })

describe("what the card offers", () => {
	it("offers to add a machine a container reached and that can run bots", () => {
		mount()

		expect(addButton()).not.toBeNull()
		expect(screen.getByText("mcc@host.docker.internal:22")).toBeDefined()
	})

	it("shows no privilege choice, since every machine is added the same way", () => {
		mount()

		expect(screen.queryByText("Privilege")).toBeNull()
		expect(screen.queryByText("Without root")).toBeNull()
		expect(screen.queryByText("With root")).toBeNull()
	})

	it.each([{ reach: "reachable" as const }, { reach: "unproven" as const }])(
		"says no, with no button, when reach is $reach",
		({ reach }) => {
			mount({ reach })

			expect(addButton()).toBeNull()
			expect(
				screen.getByText("OpenMCC cannot reach this machine, so it cannot add it."),
			).toBeDefined()
		},
	)

	it("says no, with no button, to a machine without systemd", () => {
		mount({ systemd: false })

		expect(addButton()).toBeNull()
		expect(screen.getByText("This machine has no systemd, so it cannot run bots.")).toBeDefined()
	})

	it("shows the one root command when lingering is off, and still offers to add", () => {
		mount({ linger: false })

		expect(addButton()).not.toBeNull()
		expect(screen.getByText("sudo loginctl enable-linger mcc")).toBeDefined()
	})

	it("quotes an account name the shell would otherwise split, so the operator can copy it", () => {
		mount({ linger: false, username: "bot runner" })

		expect(screen.getByText("sudo loginctl enable-linger 'bot runner'")).toBeDefined()
	})

	it("shows no command when lingering is already on", () => {
		mount()

		expect(screen.queryByText(/enable-linger/)).toBeNull()
	})

	it("shows no command beside a machine it cannot add anyway", () => {
		mount({ linger: false, reach: "unproven" })

		expect(screen.queryByText(/enable-linger/)).toBeNull()
	})
})

describe("adding the machine", () => {
	it("adds it, sets it up, and hands over the new host", async () => {
		adopt.mockResolvedValue({ id: "host-1" })
		provision.mockResolvedValue({ ok: true })
		const { onAdded } = mount()

		fireEvent.click(addButton() ?? document.body)

		await waitFor(() => expect(onAdded).toHaveBeenCalledWith("host-1"))
		expect(adopt).toHaveBeenCalledTimes(1)
		await waitFor(() => expect(provision.mock.calls[0]?.[0]).toEqual({ hostId: "host-1" }))
	})

	it("adds it without setting it up while lingering is off, which setup would stop on", async () => {
		adopt.mockResolvedValue({ id: "host-1" })
		const { onAdded } = mount({ linger: false })

		fireEvent.click(addButton() ?? document.body)

		await waitFor(() => expect(onAdded).toHaveBeenCalledWith("host-1"))
		expect(provision).not.toHaveBeenCalled()
	})

	it("says why it failed in local copy, never in the server's own words", async () => {
		adopt.mockRejectedValue(
			Object.assign(new Error("connect ECONNREFUSED 172.18.0.1:22"), {
				data: { errorCode: "SELF_HOST_UNAVAILABLE" },
			}),
		)
		const { onAdded } = mount()

		fireEvent.click(addButton() ?? document.body)

		await waitFor(() =>
			expect(screen.getByText(/cannot reach the machine it runs on/)).toBeDefined(),
		)
		expect(screen.queryByText(/172\.18\.0\.1/)).toBeNull()
		expect(onAdded).not.toHaveBeenCalled()
	})
})

describe("whether the host list offers the card at all", () => {
	it("offers it when no enrolled host is this machine", () => {
		expect(shouldOfferSelfHost(OFFER, [])).toBe(true)
		expect(shouldOfferSelfHost(OFFER, [{ hostname: "host.docker.internal", port: 2222 }])).toBe(
			true,
		)
	})

	it("stops offering it once this machine is enrolled", () => {
		expect(shouldOfferSelfHost(OFFER, [{ hostname: "host.docker.internal", port: 22 }])).toBe(false)
	})

	it("offers nothing when the server has nothing to offer", () => {
		expect(shouldOfferSelfHost(null, [])).toBe(false)
		expect(shouldOfferSelfHost(undefined, [])).toBe(false)
	})

	it("waits for the host list, so the card cannot flash up and vanish", () => {
		expect(shouldOfferSelfHost(OFFER, undefined)).toBe(false)
	})
})

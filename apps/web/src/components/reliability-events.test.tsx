import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { describeStatusEvent } from "~/lib/status-events"
import { BotReliability } from "./bot-reliability"
import { HostReliability } from "./host-reliability"

const INSTANCE_ID = "inst-1"
const HOST_ID = "host-1"

type MockEvent = {
	id: string
	kind: string
	subjectLabel: string
	hostId: string
	instanceId: string
	occurredAt: string
}

const seeded: { events: MockEvent[]; refuse: boolean } = { events: [], refuse: false }

const eventNamed = (id: string, secondsOld: number): MockEvent => ({
	id,
	kind: "instance.disconnected",
	subjectLabel: "afk-one",
	hostId: HOST_ID,
	instanceId: INSTANCE_ID,
	occurredAt: new Date(Date.UTC(2026, 8, 13, 10, 0, 0) - secondsOld * 1000).toISOString(),
})

const seed = (count: number) => {
	seeded.events = Array.from({ length: count }, (_, index) => eventNamed(`ev-${index}`, index))
}

const arrive = (count: number) => {
	seeded.events = [
		...Array.from({ length: count }, (_, index) =>
			eventNamed(`new-${count - 1 - index}`, index - count),
		),
		...seeded.events,
	]
}

const pageFrom = (limit: number, cursor: string | null) => {
	if (seeded.refuse) throw new Error("Internal server error")
	const at = cursor === null ? -1 : seeded.events.findIndex((each) => each.id === cursor)
	if (cursor !== null && at < 0) throw new Error("unknown cursor")
	const events = seeded.events.slice(at + 1, at + 1 + limit)
	const last = events[events.length - 1]
	return {
		events,
		total: seeded.events.length,
		nextCursor: last === undefined || events.length < limit ? null : last.id,
	}
}

const rowText = (each: MockEvent) =>
	`${new Date(each.occurredAt).toLocaleTimeString()}${describeStatusEvent(each.kind, each.subjectLabel)}`

const renderedRows = () => screen.getAllByRole("listitem").map((item) => item.textContent ?? "")

const SUMMARY = {
	hosts: [
		{
			hostId: HOST_ID,
			hostName: "survival",
			state: "up",
			availability: {
				goodSeconds: 86_400,
				badSeconds: 0,
				degradedSeconds: 0,
				unknownSeconds: 0,
				excludedSeconds: 0,
			},
			buckets: [],
			lastCheckedAt: new Date(Date.UTC(2026, 8, 13, 10, 0, 0)).toISOString(),
		},
	],
	bots: [
		{
			instanceId: INSTANCE_ID,
			instanceName: "afk-one",
			state: "joined",
			availability: {
				goodSeconds: 86_400,
				badSeconds: 0,
				degradedSeconds: 0,
				unknownSeconds: 0,
				excludedSeconds: 0,
			},
			buckets: [],
			lastChangeAt: null,
		},
	],
	answering: 1,
	total: 1,
	bucketSeconds: 900,
	retentionDays: 30,
}

vi.mock("~/lib/trpc", () => ({
	useTRPC: () => ({
		status: {
			summary: {
				queryOptions: () => ({ queryKey: ["status", "summary"], queryFn: () => SUMMARY }),
			},
			events: {
				infiniteQueryOptions: (
					input: { limit: number; hostId?: string; instanceId?: string },
					options: object,
				) => ({
					...options,
					queryKey: ["status", "events", input.hostId ?? input.instanceId],
					initialPageParam: null,
					queryFn: ({ pageParam }: { pageParam: string | null }) =>
						pageFrom(input.limit, pageParam),
				}),
			},
		},
	}),
}))

beforeEach(() => {
	seeded.events = []
	seeded.refuse = false
})

afterEach(() => {
	cleanup()
})

const mount = (which: "bot" | "host") => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	render(
		<QueryClientProvider client={client}>
			{which === "bot" ? (
				<BotReliability instanceId={INSTANCE_ID} />
			) : (
				<HostReliability hostId={HOST_ID} />
			)}
		</QueryClientProvider>,
	)
}

const CARDS = [
	{ which: "bot", pageSize: 8 },
	{ which: "host", pageSize: 10 },
] as const

describe.each(CARDS)("the $which card's event list", ({ which, pageSize }) => {
	it("says how many events there were, not how many it is showing", async () => {
		seed(47)
		mount(which)

		expect(await screen.findByText("47 events")).toBeDefined()
		await waitFor(() => {
			expect(screen.getAllByRole("listitem")).toHaveLength(pageSize)
		})
	})

	it("reveals the next events in place when an operator asks for more", async () => {
		seed(47)
		mount(which)

		fireEvent.click(await screen.findByRole("button", { name: "Show more" }))

		await waitFor(() => {
			expect(screen.getAllByRole("listitem")).toHaveLength(pageSize * 2)
		})
		expect(screen.getByText("47 events")).toBeDefined()
	})

	it("reaches every event without repeating one", async () => {
		seed(pageSize * 2 + 1)
		mount(which)

		fireEvent.click(await screen.findByRole("button", { name: "Show more" }))
		await waitFor(() => {
			expect(screen.getAllByRole("listitem")).toHaveLength(pageSize * 2)
		})
		fireEvent.click(screen.getByRole("button", { name: "Show more" }))
		await waitFor(() => {
			expect(screen.getAllByRole("listitem")).toHaveLength(pageSize * 2 + 1)
		})

		const rendered = renderedRows()
		expect(rendered).toEqual(seeded.events.slice(0, rendered.length).map(rowText))
		expect(new Set(rendered).size).toBe(rendered.length)
		expect(screen.queryByRole("button", { name: "Show more" })).toBeNull()
	})

	it("stops offering more once the last page is in, even as newer events arrive", async () => {
		seed(pageSize * 2 + 5)
		mount(which)

		fireEvent.click(await screen.findByRole("button", { name: "Show more" }))
		await waitFor(() => {
			expect(screen.getAllByRole("listitem")).toHaveLength(pageSize * 2)
		})

		arrive(3)
		fireEvent.click(screen.getByRole("button", { name: "Show more" }))
		await waitFor(() => {
			expect(screen.getAllByRole("listitem")).toHaveLength(pageSize * 2 + 5)
		})

		const rendered = renderedRows()
		expect(new Set(rendered).size).toBe(rendered.length)
		expect(screen.getByText(`${pageSize * 2 + 8} events`)).toBeDefined()
		expect(screen.queryByRole("button", { name: "Show more" })).toBeNull()
	})

	it("offers nothing to press when every event already fits", async () => {
		seed(pageSize)
		mount(which)

		expect(await screen.findByText(`${pageSize} events`)).toBeDefined()
		expect(screen.queryByRole("button", { name: "Show more" })).toBeNull()
	})

	it("counts one event as one", async () => {
		seed(1)
		mount(which)

		expect(await screen.findByText("1 event")).toBeDefined()
		expect(screen.queryByRole("button", { name: "Show more" })).toBeNull()
	})

	it("shows no list at all when nothing was recorded", async () => {
		seed(0)
		mount(which)

		await waitFor(() => {
			expect(screen.queryByRole("list")).toBeNull()
		})
		expect(screen.queryByRole("button", { name: "Show more" })).toBeNull()
	})

	it("says so when the events cannot be read", async () => {
		seed(47)
		seeded.refuse = true
		mount(which)

		expect(await screen.findByRole("alert")).toBeDefined()
	})

	it("says so when asking for more fails, rather than looking like a dead button", async () => {
		seed(47)
		mount(which)

		const more = await screen.findByRole("button", { name: "Show more" })
		seeded.refuse = true
		fireEvent.click(more)

		expect(await screen.findByRole("alert")).toBeDefined()
		expect(screen.getAllByRole("listitem")).toHaveLength(pageSize)
	})
})

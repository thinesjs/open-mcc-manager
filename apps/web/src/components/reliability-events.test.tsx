import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BotReliability } from "./bot-reliability"
import { HostReliability } from "./host-reliability"

const INSTANCE_ID = "inst-1"
const HOST_ID = "host-1"

const seeded = { total: 0 }

const eventAt = (index: number) => ({
	id: `ev-${index}`,
	kind: "instance.disconnected",
	subjectLabel: "afk-one",
	hostId: HOST_ID,
	instanceId: INSTANCE_ID,
	occurredAt: new Date(Date.UTC(2026, 8, 13, 10, 0, index)).toISOString(),
})

const pageFrom = (limit: number, cursor: string | null) => {
	const start = cursor === null ? 0 : Number(cursor)
	const events = Array.from({ length: Math.min(limit, seeded.total - start) }, (_, offset) =>
		eventAt(start + offset),
	)
	const next = start + events.length
	return {
		events,
		total: seeded.total,
		nextCursor: events.length < limit ? null : String(next),
	}
}

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
	seeded.total = 0
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
		seeded.total = 47
		mount(which)

		expect(await screen.findByText("47 events")).toBeDefined()
		await waitFor(() => {
			expect(screen.getAllByRole("listitem")).toHaveLength(pageSize)
		})
	})

	it("reveals the next events in place when an operator asks for more", async () => {
		seeded.total = 47
		mount(which)

		fireEvent.click(await screen.findByRole("button", { name: "Show more" }))

		await waitFor(() => {
			expect(screen.getAllByRole("listitem")).toHaveLength(pageSize * 2)
		})
		expect(screen.getByText("47 events")).toBeDefined()
	})

	it("offers nothing to press when every event already fits", async () => {
		seeded.total = pageSize
		mount(which)

		expect(await screen.findByText(`${pageSize} events`)).toBeDefined()
		expect(screen.queryByRole("button", { name: "Show more" })).toBeNull()
	})

	it("counts one event as one", async () => {
		seeded.total = 1
		mount(which)

		expect(await screen.findByText("1 event")).toBeDefined()
		expect(screen.queryByRole("button", { name: "Show more" })).toBeNull()
	})

	it("shows no list at all when nothing was recorded", async () => {
		seeded.total = 0
		mount(which)

		await waitFor(() => {
			expect(screen.queryByRole("list")).toBeNull()
		})
		expect(screen.queryByRole("button", { name: "Show more" })).toBeNull()
	})
})

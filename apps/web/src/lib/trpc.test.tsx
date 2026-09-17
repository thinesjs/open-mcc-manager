import { focusManager, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { queryClient } from "./trpc"

const answeredWith = (httpStatus: number): Error =>
	Object.assign(new Error("the server said no"), { data: { httpStatus } })

const attempts = async (key: string, error: Error): Promise<number> => {
	let calls = 0
	await queryClient
		.fetchQuery({
			queryKey: [key],
			retryDelay: 0,
			queryFn: async (): Promise<string> => {
				calls += 1
				throw error
			},
		})
		.catch(() => undefined)
	return calls
}

const Probe = ({ onRead }: { onRead: () => void }) => {
	const query = useQuery({
		queryKey: ["focus"],
		queryFn: async (): Promise<string> => {
			onRead()
			return "read"
		},
	})
	return <span>{query.data ?? "reading"}</span>
}

describe("the query client the dashboard runs on", () => {
	afterEach(() => {
		cleanup()
		focusManager.setFocused(undefined)
		queryClient.clear()
	})

	it("★ asks once for what the server refused, rather than leaving the reader waiting on retries", async () => {
		expect(await attempts("forbidden", answeredWith(403))).toBe(1)
		expect(await attempts("gone", answeredWith(404))).toBe(1)
		expect(await attempts("stale", answeredWith(409))).toBe(1)
	})

	it("★ still retries a server fault and a request that never arrived", async () => {
		expect(await attempts("faulted", answeredWith(500))).toBe(4)
		expect(await attempts("unreachable", new Error("Failed to fetch"))).toBe(4)
	})

	it("★ leaves the page as it is when the operator comes back to the tab", async () => {
		let reads = 0
		render(
			<QueryClientProvider client={queryClient}>
				<Probe onRead={() => (reads += 1)} />
			</QueryClientProvider>,
		)
		await screen.findByText("read")

		focusManager.setFocused(false)
		await act(async () => {
			focusManager.setFocused(true)
		})

		expect(reads).toBe(1)
	})
})

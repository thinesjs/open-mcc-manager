import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ReleaseNotesView, UpdateStatus } from "@open-mcc/contracts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CHECK_FAILURE_COPY } from "~/lib/update-status"
import { BuildBadge } from "./control-plane-status"
import { ReleaseNotes, UpdateModal } from "./update-modal"

const here = dirname(fileURLToPath(import.meta.url))

const served = vi.hoisted(() => {
	const answers: { update: UpdateStatus | undefined; notes: ReleaseNotesView | null } = {
		update: undefined,
		notes: null,
	}
	return answers
})

vi.mock("~/lib/trpc", () => ({
	useTRPC: () => ({
		system: {
			status: {
				queryOptions: () => ({
					queryKey: ["system", "status"],
					queryFn: async () => ({
						condition: "healthy",
						server: { version: "1.4.0", commit: "abc123def456", schemaVersion: "0032" },
						worker: null,
					}),
				}),
			},
			updateStatus: {
				queryOptions: () => ({
					queryKey: ["system", "updateStatus"],
					queryFn: async () => served.update,
				}),
			},
			releaseNotes: {
				queryOptions: () => ({
					queryKey: ["system", "releaseNotes"],
					queryFn: async () => served.notes,
				}),
			},
		},
	}),
}))

afterEach(() => {
	cleanup()
	served.update = undefined
	served.notes = null
})

const SOURCE = { owner: "thinesjs", repo: "open-mcc-manager" }

const checked = (
	patch: Partial<Extract<UpdateStatus, { kind: "checked" }>> = {},
): UpdateStatus => ({
	kind: "checked",
	running: "1.4.0",
	latest: "1.5.0",
	available: true,
	checkedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
	outcome: "ok",
	rateLimitedUntil: null,
	source: SOURCE,
	...patch,
})

const notesWith = (patch: Partial<ReleaseNotesView> = {}): ReleaseNotesView => ({
	version: "1.5.0",
	source: SOURCE,
	blocks: [
		{ kind: "paragraph", start: 0, spans: [{ kind: "text", start: 0, text: "Faster bots." }] },
	],
	truncated: false,
	...patch,
})

const Layout = () => {
	const [open, setOpen] = useState(false)
	return (
		<>
			<UpdateModal open={open} onClose={() => setOpen(false)} />
			<BuildBadge onOpenUpdate={() => setOpen(true)} />
		</>
	)
}

const mountBadge = async (update: UpdateStatus) => {
	served.update = update
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	render(
		<QueryClientProvider client={client}>
			<Layout />
		</QueryClientProvider>,
	)
	await screen.findByText("1.4.0 · abc123def456")
	await waitFor(() => expect(client.isFetching()).toBe(0))
}

const openBadge = async () => {
	fireEvent.click(screen.getByRole("button", { name: /1\.4\.0 · abc123def456/ }))
	return await screen.findByRole("dialog")
}

describe("where the update opens", () => {
	const layout = readFileSync(join(here, "..", "routes", "_authenticated.tsx"), "utf8")
	const badge = readFileSync(join(here, "control-plane-status.tsx"), "utf8")

	it("opens from the layout root, outside the sidebar whose translate would clip it to its width", () => {
		const asideOpens = layout.indexOf("<aside")
		const asideCloses = layout.indexOf("</aside>")
		const modalAt = layout.indexOf("<UpdateModal")

		expect(asideOpens).toBeGreaterThan(-1)
		expect(asideCloses).toBeGreaterThan(asideOpens)
		expect(layout.split("<UpdateModal").length - 1).toBe(1)
		expect(modalAt > asideOpens && modalAt < asideCloses).toBe(false)
	})

	it("is never mounted by the badge, which lives inside the sidebar", () => {
		expect(badge).not.toContain("<UpdateModal")
	})
})

describe("the build badge", () => {
	it("marks a development build and offers nothing to open", async () => {
		await mountBadge({ kind: "development" })

		expect(screen.getByText("dev")).toBeDefined()
		expect(screen.queryByRole("button")).toBeNull()
		expect(screen.queryByText("Update available")).toBeNull()
	})

	it("explains the development marker in its tooltip", async () => {
		await mountBadge({ kind: "development" })

		fireEvent.focus(screen.getByText("dev"))

		expect(await screen.findByText("Development builds are not updated from here.")).toBeDefined()
	})

	it("shows the up-arrow when a newer release is available", async () => {
		await mountBadge(checked())

		expect(screen.getByText("Update available")).toBeDefined()
		expect(screen.queryByText("dev")).toBeNull()
	})

	it("shows no up-arrow when the running release is the newest", async () => {
		await mountBadge(checked({ latest: "1.4.0", available: false }))

		expect(screen.queryByText("Update available")).toBeNull()
		expect(screen.getByRole("button", { name: /1\.4\.0 · abc123def456/ })).toBeDefined()
	})

	it("opens the update with the version on offer and the one running", async () => {
		served.notes = notesWith()
		await mountBadge(checked())

		const dialog = await openBadge()

		expect(dialog.getAttribute("aria-label")).toBe("Update available")
		expect(within(dialog).getByText("1.5.0 · you are on 1.4.0")).toBeDefined()
		expect(await within(dialog).findByText("Faster bots.")).toBeDefined()
	})

	it("opens as up to date, with when it last checked", async () => {
		await mountBadge(checked({ latest: "1.4.0", available: false }))

		const dialog = await openBadge()

		expect(dialog.getAttribute("aria-label")).toBe("Up to date")
		expect(within(dialog).getByText("1.4.0 · checked 2 hours ago")).toBeDefined()
	})

	it("says the last check failed when it did", async () => {
		await mountBadge(checked({ outcome: "unreachable" }))

		const dialog = await openBadge()

		expect(within(dialog).getByText("Last check failed")).toBeDefined()
	})

	it("says nothing about a failed check when the last check worked", async () => {
		await mountBadge(checked({ outcome: "ok" }))

		const dialog = await openBadge()

		expect(within(dialog).queryByText("Last check failed")).toBeNull()
	})

	it("shows it is still checking before the first answer", async () => {
		await mountBadge({ kind: "unchecked", running: "1.4.0" })

		const dialog = await openBadge()

		expect(within(dialog).getByRole("img", { name: "Checking" })).toBeDefined()
	})
})

describe("a check that has never found a release", () => {
	it("is titled no release found and says why in text that is on the page, not in a tooltip", async () => {
		await mountBadge(checked({ latest: null, available: false, outcome: "not-found" }))

		const dialog = await openBadge()

		expect(dialog.getAttribute("aria-label")).toBe("No release found")
		expect(within(dialog).getByText(CHECK_FAILURE_COPY["not-found"])).toBeDefined()
		expect(within(dialog).queryByText("Last check failed")).toBeNull()
	})

	it("is still titled a failed check when GitHub could not be asked, and says why on the page", async () => {
		await mountBadge(checked({ latest: null, available: false, outcome: "unreachable" }))

		const dialog = await openBadge()

		expect(dialog.getAttribute("aria-label")).toBe("Update check failed")
		expect(within(dialog).getByText(CHECK_FAILURE_COPY.unreachable)).toBeDefined()
	})

	it("keeps calling it a failed check when a release was found before and the repository is gone now", async () => {
		await mountBadge(checked({ latest: "1.4.0", available: false, outcome: "not-found" }))

		const dialog = await openBadge()

		expect(dialog.getAttribute("aria-label")).toBe("Up to date")
		expect(within(dialog).getByText("Last check failed")).toBeDefined()
	})
})

const notesRegion = (container: HTMLElement): HTMLElement => {
	const region = container.querySelector<HTMLElement>('[data-slot="release-notes"]')
	if (region === null) throw new Error("no release notes region rendered")
	return region
}

describe("release notes on the page", () => {
	it("says whose notes they are", () => {
		render(<ReleaseNotes notes={notesWith()} />)

		expect(screen.getByText("Release notes from thinesjs/open-mcc-manager")).toBeDefined()
	})

	it("shows <script>alert(1)</script> as text and never runs it", () => {
		const { container } = render(
			<ReleaseNotes
				notes={notesWith({
					blocks: [
						{
							kind: "paragraph",
							start: 0,
							spans: [{ kind: "text", start: 0, text: "<script>alert(1)</script>" }],
						},
					],
				})}
			/>,
		)

		expect(container.querySelector("script")).toBeNull()
		expect(notesRegion(container).textContent).toBe("<script>alert(1)</script>")
	})

	it("shows a javascript: link as its words and address, never as a link", () => {
		const { container } = render(
			<ReleaseNotes
				notes={notesWith({
					blocks: [
						{
							kind: "paragraph",
							start: 0,
							spans: [{ kind: "link", start: 0, label: "click", url: "javascript:alert(1)" }],
						},
					],
				})}
			/>,
		)

		const region = notesRegion(container)
		expect(region.querySelectorAll("a")).toHaveLength(0)
		expect(region.querySelectorAll("[href]")).toHaveLength(0)
		expect(region.textContent).toBe("click (javascript:alert(1))")
	})

	it("links only to the release page built from the source and version", () => {
		const { container } = render(<ReleaseNotes notes={notesWith()} />)

		const hrefs = Array.from(container.querySelectorAll("a")).map((link) =>
			link.getAttribute("href"),
		)
		expect(hrefs).toEqual(["https://github.com/thinesjs/open-mcc-manager/releases/tag/v1.5.0"])
	})

	it("shows the first twelve blocks until asked for the rest", () => {
		const blocks = Array.from({ length: 15 }, (_, n) => ({
			kind: "paragraph" as const,
			start: n * 10,
			spans: [{ kind: "text" as const, start: 0, text: `block ${n}` }],
		}))
		const { container } = render(<ReleaseNotes notes={notesWith({ blocks })} />)

		expect(notesRegion(container).children).toHaveLength(12)
		fireEvent.click(screen.getByRole("button", { name: "Show all" }))
		expect(notesRegion(container).children).toHaveLength(15)
		expect(screen.queryByRole("button", { name: "Show all" })).toBeNull()
	})

	it("offers no Show all when every block already fits", () => {
		render(<ReleaseNotes notes={notesWith()} />)

		expect(screen.queryByRole("button", { name: "Show all" })).toBeNull()
	})

	it("says the notes were cut short", () => {
		render(<ReleaseNotes notes={notesWith({ truncated: true })} />)

		expect(screen.getByText(/Notes truncated/)).toBeDefined()
	})

	it("says nothing about cutting notes that were not cut", () => {
		render(<ReleaseNotes notes={notesWith({ truncated: false })} />)

		expect(screen.queryByText(/Notes truncated/)).toBeNull()
	})
})

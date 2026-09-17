import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { COMMAND_HISTORY_PREFIX, writeCommandHistory } from "~/lib/command-history"
import { Route } from "./_authenticated"

const signOut = vi.fn(() => Promise.resolve())
const navigate = vi.fn()

vi.mock("~/lib/auth-client", () => ({
	authClient: {
		signOut: () => signOut(),
		useSession: () => ({ data: { user: { name: "Ada", email: "ada@example.com" } } }),
		getSession: () => Promise.resolve({ data: null }),
	},
}))

vi.mock("~/lib/trpc", () => ({
	useTRPC: () => ({
		member: {
			me: {
				queryOptions: () => ({ queryKey: ["member", "me"], queryFn: () => ({ role: "owner" }) }),
			},
		},
	}),
}))

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<object>()),
	createFileRoute: () => (options: object) => ({ options }),
	Link: ({ children }: { children?: ReactNode }) => <a href="/">{children}</a>,
	Outlet: () => null,
	useNavigate: () => navigate,
	useLocation: () => ({ pathname: "/hosts" }),
}))

vi.mock("~/components/command-palette", () => ({ CommandPalette: () => null }))
vi.mock("~/components/update-modal", () => ({ UpdateModal: () => null }))
vi.mock("~/components/control-plane-status", () => ({
	BuildBadge: () => null,
	ControlPlaneStatus: () => null,
}))

const THEME_KEY = "open-mcc-theme"
const VIEW_KEY = "hosts"

vi.stubGlobal("matchMedia", () => ({
	matches: false,
	addEventListener: () => undefined,
	removeEventListener: () => undefined,
}))

afterEach(() => {
	cleanup()
	signOut.mockClear()
	navigate.mockClear()
	window.localStorage.clear()
})

const stored = (instanceId: string): string | null =>
	window.localStorage.getItem(`${COMMAND_HISTORY_PREFIX}${instanceId}`)

const mountShell = async () => {
	const Shell = Route.options.component
	if (Shell === undefined) throw new Error("the route renders no shell")
	await Shell.preload?.()
	render(
		<QueryClientProvider client={new QueryClient()}>
			<Shell />
		</QueryClientProvider>,
	)
}

describe("signing out on a shared machine", () => {
	it("leaves no bot's console history behind, and keeps the settings that are not one", async () => {
		writeCommandHistory("abc123", ["/list", "/say hi"])
		writeCommandHistory("def456", ["/time set day"])
		window.localStorage.setItem(THEME_KEY, "dark")
		window.localStorage.setItem(VIEW_KEY, "list")
		await mountShell()

		await act(async () => {
			screen.getByText("Sign out").click()
		})

		expect(signOut).toHaveBeenCalledTimes(1)
		expect(stored("abc123")).toBeNull()
		expect(stored("def456")).toBeNull()
		expect(window.localStorage.getItem(THEME_KEY)).toBe("dark")
		expect(window.localStorage.getItem(VIEW_KEY)).toBe("list")
	})

	it("leaves the history alone until someone signs out", async () => {
		writeCommandHistory("abc123", ["/list", "/say hi"])
		await mountShell()

		expect(stored("abc123")).toBe("/list\n/say hi")
	})
})

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { COMMAND_HISTORY_PREFIX, writeCommandHistory } from "~/lib/command-history"
import { CommandPalette } from "./command-palette"
import { SignedInNotice } from "./invitation-notice"

const signOut = vi.fn(() => Promise.resolve())

vi.mock("~/lib/auth-client", () => ({ authClient: { signOut: () => signOut() } }))

vi.mock("~/lib/trpc", () => ({
	useTRPC: () => ({
		instance: {
			list: { queryOptions: () => ({ queryKey: ["instance", "list"], queryFn: () => [] }) },
			start: { mutationOptions: (options: object) => ({ ...options, mutationFn: () => null }) },
			stop: { mutationOptions: (options: object) => ({ ...options, mutationFn: () => null }) },
			restart: { mutationOptions: (options: object) => ({ ...options, mutationFn: () => null }) },
		},
		host: { list: { queryOptions: () => ({ queryKey: ["host", "list"], queryFn: () => [] }) } },
	}),
}))

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => () => undefined,
	useRouter: () => ({ invalidate: () => Promise.resolve() }),
}))

vi.stubGlobal("matchMedia", () => ({
	matches: false,
	addEventListener: () => undefined,
	removeEventListener: () => undefined,
}))

const THEME_KEY = "open-mcc-theme"
const VIEW_KEY = "open-mcc.view.hosts"

const src = join(dirname(fileURLToPath(import.meta.url)), "..")

const filesNaming = (needle: string, dir: string = src): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) return filesNaming(needle, full)
		if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return []
		return readFileSync(full, "utf8").includes(needle) ? [relative(src, full)] : []
	})

afterEach(() => {
	cleanup()
	signOut.mockClear()
	window.localStorage.clear()
})

const stored = (instanceId: string): string | null =>
	window.localStorage.getItem(`${COMMAND_HISTORY_PREFIX}${instanceId}`)

const seed = () => {
	writeCommandHistory("abc123", ["/list", "/say hi"])
	writeCommandHistory("def456", ["/time set day"])
	window.localStorage.setItem(THEME_KEY, "dark")
	window.localStorage.setItem(VIEW_KEY, "list")
}

const expectHistoryGoneAndTheRestKept = () => {
	expect(signOut).toHaveBeenCalledTimes(1)
	expect(stored("abc123")).toBeNull()
	expect(stored("def456")).toBeNull()
	expect(window.localStorage.getItem(THEME_KEY)).toBe("dark")
	expect(window.localStorage.getItem(VIEW_KEY)).toBe("list")
}

describe("every way an operator can sign out", () => {
	it("is one of exactly three, and each clears the console history", () => {
		expect(filesNaming("authClient.signOut").sort()).toEqual([
			join("components", "command-palette.tsx"),
			join("components", "invitation-notice.tsx"),
			join("routes", "_authenticated.tsx"),
		])
		for (const file of filesNaming("authClient.signOut")) {
			expect(readFileSync(join(src, file), "utf8")).toContain("clearCommandHistories()")
		}
	})
})

describe("signing out from the command palette", () => {
	it("leaves no bot's console history behind, and keeps the settings that are not one", async () => {
		seed()
		render(
			<QueryClientProvider client={new QueryClient()}>
				<CommandPalette open instant onClose={() => undefined} />
			</QueryClientProvider>,
		)

		await act(async () => {
			screen.getByText("Sign out").click()
		})

		expectHistoryGoneAndTheRestKept()
	})
})

describe("signing out to accept an invitation on the same machine", () => {
	it("leaves no bot's console history behind, and keeps the settings that are not one", async () => {
		seed()
		render(<SignedInNotice email="ada@example.com" />)

		await act(async () => {
			screen.getByText("Sign out").click()
		})

		expectHistoryGoneAndTheRestKept()
	})
})

import { describe, expect, it, vi } from "vitest"
import { avatarSourceUrl, MINECRAFT_NAME_PATTERN, readAvatar } from "./avatar"

const imageResponse = () =>
	new Response(new Uint8Array([137, 80, 78, 71]), {
		status: 200,
		headers: { "content-type": "image/png" },
	})

describe("serving a player's avatar without the browser talking to a skin service", () => {
	it("fetches on the operator's behalf, so the service never sees who is viewing", async () => {
		const fetchImpl = vi.fn(async () => imageResponse())

		const image = await readAvatar("Notch", fetchImpl)

		expect(image?.contentType).toBe("image/png")
		expect(fetchImpl).toHaveBeenCalledWith(avatarSourceUrl("Notch"), expect.anything())
	})

	it("refuses a name Minecraft could not issue, rather than forwarding it anywhere", async () => {
		const fetchImpl = vi.fn(async () => imageResponse())

		for (const name of ["", "ab", "much too long a name", "../../etc/passwd", "a b"]) {
			expect(await readAvatar(name, fetchImpl)).toBeUndefined()
		}
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it("returns nothing when the service answers with something that is not an image", async () => {
		const fetchImpl = vi.fn(
			async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
		)

		expect(await readAvatar("Notch", fetchImpl)).toBeUndefined()
	})

	it("returns nothing rather than throwing when the service is unreachable", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("network down")
		})

		expect(await readAvatar("Notch", fetchImpl)).toBeUndefined()
	})

	it("gives up rather than hanging when the service never answers", async () => {
		const fetchImpl = vi.fn(
			(_url: string, signal: AbortSignal) =>
				new Promise<Response>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")))
				}),
		)

		expect(await readAvatar("Notch", fetchImpl)).toBeUndefined()
	}, 10_000)

	it("accepts exactly the names Minecraft allows", () => {
		expect(MINECRAFT_NAME_PATTERN.test("Notch")).toBe(true)
		expect(MINECRAFT_NAME_PATTERN.test("Player_123")).toBe(true)
		expect(MINECRAFT_NAME_PATTERN.test("no-hyphens")).toBe(false)
	})
})

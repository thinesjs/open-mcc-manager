import { describe, expect, it } from "vitest"
import { flattenChatComponent, parseChatComponent, safeParseChatComponent } from "./chat-component"
import motdFixture from "./motd-fixture.json"

const textOf = (component: unknown, translate?: (key: string) => string | undefined) =>
	flattenChatComponent(parseChatComponent(component), translate)
		.map((span) => span.text)
		.join("")

describe("chat components", () => {
	it("accepts a bare string as a component", () => {
		expect(parseChatComponent("hello")).toEqual({ text: "hello" })
	})

	it("accepts an array as a component, which servers do send", () => {
		expect(textOf(["a", "b"])).toBe("ab")
	})

	it("inherits a parent's style into a child that does not set it", () => {
		const spans = flattenChatComponent(
			parseChatComponent({ bold: true, color: "red", extra: [{ text: "child" }] }),
		)

		expect(spans[0]?.bold).toBe(true)
		expect(spans[0]?.color).toBe("red")
	})

	it("lets a child override the style it inherits", () => {
		const spans = flattenChatComponent(
			parseChatComponent({ bold: true, extra: [{ text: "child", bold: false }] }),
		)

		expect(spans[0]?.bold).toBe(false)
	})

	it("substitutes translation arguments in order", () => {
		expect(textOf({ translate: "chat.type.text", with: ["Steve", "hi"] }, () => "<%s> %s")).toBe(
			"<Steve> hi",
		)
	})

	it("honours an explicitly indexed argument", () => {
		expect(textOf({ translate: "k", with: ["a", "b"] }, () => "%2$s then %1$s")).toBe("b then a")
	})

	it("renders a literal percent from the escape", () => {
		expect(textOf({ translate: "k", with: [] }, () => "100%% sure")).toBe("100% sure")
	})

	it("degrades to the arguments when a translation key is unknown", () => {
		expect(textOf({ translate: "some.unknown.key", with: ["Steve"] })).toBe("Steve")
	})

	it("degrades to the key itself when it is unknown and carries no arguments", () => {
		expect(textOf({ translate: "some.unknown.key" })).toBe("some.unknown.key")
	})

	it("keeps a translated argument's own styling", () => {
		const spans = flattenChatComponent(
			parseChatComponent({
				translate: "k",
				with: [{ text: "Steve", color: "aqua" }],
			}),
			() => "<%s>",
		)

		expect(spans.find((span) => span.text === "Steve")?.color).toBe("aqua")
	})

	it("rejects a colour that is neither a name nor a hex triplet", () => {
		expect(safeParseChatComponent({ text: "x", color: "octarine" })).toBeUndefined()
	})

	it("accepts a 1.16 hex colour", () => {
		expect(parseChatComponent({ text: "x", color: "#ff0088" })).toEqual({
			text: "x",
			color: "#ff0088",
		})
	})

	it("returns undefined rather than throwing on malformed input", () => {
		expect(safeParseChatComponent({ extra: "not-an-array" })).toBeUndefined()
	})

	it("drops a key it does not model rather than failing the whole component", () => {
		expect(parseChatComponent({ text: "x", insertion: "y" })).toEqual({ text: "x" })
	})

	it("flattens a real server's MOTD", () => {
		const spans = flattenChatComponent(parseChatComponent(motdFixture))
		const rendered = spans.map((span) => span.text).join("")

		expect(rendered).toContain("Jartex")
		expect(rendered).toContain("Network")
		expect(rendered).toContain("NEW SKYBLOCK SEASON")
		expect(spans.find((span) => span.text === "Jartex")?.color).toBe("yellow")
		expect(spans.find((span) => span.text === "Jartex")?.bold).toBe(true)
		expect(spans.find((span) => span.text === "Network")?.color).toBe("gold")
	})

	it("produces no span for an empty text node", () => {
		expect(flattenChatComponent(parseChatComponent({ text: "" }))).toEqual([])
	})
})

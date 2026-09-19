import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { McpStatusEffect } from "@open-mcc/contracts/boundary/mcp-readouts"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { LiveReadouts } from "./live-readouts"

const here = dirname(fileURLToPath(import.meta.url))
const detail = readFileSync(
	join(here, "..", "routes", "_authenticated.instances.$instanceId.tsx"),
	"utf8",
)

const STATS = {
	health: 18.5,
	foodLevel: 17,
	level: 30,
	totalExperience: 1395,
	gamemode: 1,
	currentSlot: 7,
	yaw: -134,
	pitch: 12,
	tps: 19.5,
}

const EFFECTS: McpStatusEffect[] = [
	{ id: "Regeneration", amplifier: 2, remainingSeconds: 42, isInfinite: false },
]

const BOTS = [
	{ name: "AntiAfk", isScript: false },
	{ name: "Script", isScript: true },
	{ name: "Script", isScript: true },
]

const PLAYERS = ["Steve", "Alex_99"]

const rendered = (overrides: Partial<Parameters<typeof LiveReadouts>[0]> = {}): string =>
	renderToStaticMarkup(
		<LiveReadouts stats={STATS} effects={EFFECTS} bots={BOTS} players={PLAYERS} {...overrides} />,
	)

describe("what the four readouts put on the page", () => {
	it.each([
		{ named: "the player stats", value: "1395" },
		{ named: "the status effects", value: "Regeneration 3" },
		{ named: "the loaded bots", value: "AntiAfk" },
		{ named: "the players online", value: "Alex_99" },
	])("renders $named", ({ value }) => {
		expect(rendered()).toContain(value)
	})

	it("calls the food level Food, never the client's own misnomer", () => {
		const markup = rendered()

		expect(markup).toContain("Food")
		expect(markup).toContain(">17<")
		expect(markup).not.toContain("Saturation")
	})

	it("keeps the half hearts the server actually sent rather than rounding them away", () => {
		expect(rendered()).toContain("18.5")
	})

	it("shows the server tick rate this readout carries, which the world panel is gated apart from", () => {
		expect(rendered()).toContain("19.5 tps")
	})

	it("names the game mode rather than showing its number", () => {
		const markup = rendered()

		expect(markup).toContain("Creative")
		expect(markup).not.toContain(">1</dd>")
	})

	it("shows the held slot one-based, as the client reports it", () => {
		expect(rendered()).toContain(">7<")
	})
})

describe("a readout that has not answered", () => {
	it.each([
		{
			named: "stats",
			overrides: { stats: null },
			gone: "1395",
			survive: ["Regeneration 3", "AntiAfk", "Alex_99"],
		},
		{
			named: "effects",
			overrides: { effects: null },
			gone: "Regeneration 3",
			survive: ["1395", "AntiAfk", "Alex_99"],
		},
		{
			named: "bots",
			overrides: { bots: null },
			gone: "AntiAfk",
			survive: ["1395", "Regeneration 3", "Alex_99"],
		},
		{
			named: "players",
			overrides: { players: null },
			gone: "Alex_99",
			survive: ["1395", "Regeneration 3", "AntiAfk"],
		},
	])("hides only $named and leaves the other three on the page", ({ overrides, gone, survive }) => {
		const markup = rendered(overrides)

		expect(markup).not.toContain(gone)
		expect(markup).toContain("Not answering yet")
		for (const kept of survive) {
			expect(markup).toContain(kept)
		}
	})

	it.each([
		{ named: "no effects", overrides: { effects: [] }, says: "None active." },
		{ named: "nobody online", overrides: { players: [] }, says: "Nobody else is on the server." },
		{ named: "no bots", overrides: { bots: [] }, says: "None loaded." },
	])("tells $named apart from not having answered", ({ overrides, says }) => {
		const markup = rendered(overrides)

		expect(markup).toContain(says)
		expect(markup).not.toContain("Not answering yet")
	})
})

describe("two scripts with the same name", () => {
	it("puts both on the page", () => {
		expect(rendered().split("Script</dt>")).toHaveLength(3)
	})

	it("gives each row a key qualified by its occurrence, which rendered markup cannot show", () => {
		const source = readFileSync(join(here, "live-readouts.tsx"), "utf8")

		expect(source).toContain("seen.get(bot.name)")
		expect(source).toContain("key={bot.key}")
	})
})

const QUERIES = [
	{ prop: "stats", query: "livePlayerStatsQuery", procedure: "readLivePlayerStats" },
	{ prop: "effects", query: "liveStatusEffectsQuery", procedure: "readLiveStatusEffects" },
	{ prop: "bots", query: "liveBotsQuery", procedure: "readLiveBots" },
	{ prop: "players", query: "livePlayersQuery", procedure: "readLivePlayers" },
] as const

const queryBlock = (query: string): string => {
	const start = detail.indexOf(`const ${query} = useQuery({`)
	return start < 0 ? "" : detail.slice(start, detail.indexOf("\t})", start))
}

describe("how the route feeds the readouts", () => {
	it.each(QUERIES)("asks the server for $procedure", ({ query, procedure }) => {
		expect(queryBlock(query)).toContain(`trpc.instance.${procedure}.queryOptions({ instanceId })`)
	})

	it.each(QUERIES)(
		"hands $query to the $prop the component renders only while it is live",
		({ prop, query }) => {
			expect(detail).toContain(`${prop}={liveReading(${query}, liveOn)}`)
		},
	)

	it("mounts the readouts outside the world block, so an absent world cannot hide them", () => {
		const worldBlock = detail.indexOf("{liveWorld ? (")
		const worldClosed = detail.indexOf(") : null}", worldBlock)

		expect(detail.indexOf("<LiveReadouts")).toBeGreaterThan(worldClosed)
	})
})

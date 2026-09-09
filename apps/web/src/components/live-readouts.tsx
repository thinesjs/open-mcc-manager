import type {
	McpLoadedBot,
	McpPlayerStats,
	McpStatusEffect,
} from "@open-mcc/contracts/boundary/mcp-readouts"

export type LiveReadoutsProps = {
	stats: McpPlayerStats | null | undefined
	effects: McpStatusEffect[] | null | undefined
	bots: McpLoadedBot[] | null | undefined
	players: string[] | null | undefined
}

const GAME_MODES: Record<number, string> = {
	0: "Survival",
	1: "Creative",
	2: "Adventure",
	3: "Spectator",
}

const facing = (yaw: number, pitch: number): string => `${Math.round(yaw)}° / ${Math.round(pitch)}°`

const exact = (value: number): string => (Number.isInteger(value) ? `${value}` : value.toFixed(1))

const effectDuration = (remainingSeconds: number): string => {
	if (remainingSeconds < 0) return "forever"
	if (remainingSeconds < 60) return `${remainingSeconds}s`
	return `${Math.round(remainingSeconds / 60)}m`
}

const numbered = (bots: readonly McpLoadedBot[]): Array<McpLoadedBot & { key: string }> => {
	const seen = new Map<string, number>()
	return bots.map((bot) => {
		const occurrence = (seen.get(bot.name) ?? 0) + 1
		seen.set(bot.name, occurrence)
		return { ...bot, key: `${bot.name}#${occurrence}` }
	})
}

const Row = ({ label, value }: { label: string; value: string }) => (
	<div className="flex justify-between gap-4">
		<dt className="text-sm text-muted-foreground">{label}</dt>
		<dd className="text-sm tabular-nums text-foreground">{value}</dd>
	</div>
)

const Waiting = () => (
	<p className="text-sm text-muted-foreground">
		Not answering yet. The client only reports this once it has joined a server.
	</p>
)

export const LiveReadouts = ({ stats, effects, bots, players }: LiveReadoutsProps) => (
	<div className="space-y-4">
		<div className="space-y-1.5">
			<h3 className="text-sm font-medium text-foreground">Player</h3>
			{stats ? (
				<dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
					<Row label="Health" value={exact(stats.health)} />
					<Row label="Food" value={`${stats.foodLevel}`} />
					<Row label="Level" value={`${stats.level}`} />
					<Row label="Experience" value={`${stats.totalExperience}`} />
					<Row label="Mode" value={GAME_MODES[stats.gamemode] ?? "Unknown"} />
					<Row label="Held slot" value={`${stats.currentSlot}`} />
					<Row label="Facing" value={facing(stats.yaw, stats.pitch)} />
					<Row label="Server ticks" value={`${exact(stats.tps)} tps`} />
				</dl>
			) : (
				<Waiting />
			)}
		</div>

		<div className="space-y-1.5">
			<h3 className="text-sm font-medium text-foreground">Effects</h3>
			{effects === null || effects === undefined ? (
				<Waiting />
			) : effects.length === 0 ? (
				<p className="text-sm text-muted-foreground">None active.</p>
			) : (
				<dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
					{effects.map((effect) => (
						<Row
							key={effect.id}
							label={`${effect.id} ${effect.amplifier + 1}`}
							value={effectDuration(effect.remainingSeconds)}
						/>
					))}
				</dl>
			)}
		</div>

		<div className="space-y-1.5">
			<h3 className="text-sm font-medium text-foreground">Players online</h3>
			{players === null || players === undefined ? (
				<Waiting />
			) : players.length === 0 ? (
				<p className="text-sm text-muted-foreground">Nobody else is on the server.</p>
			) : (
				<p className="text-sm text-foreground">{players.join(", ")}</p>
			)}
		</div>

		<div className="space-y-1.5">
			<h3 className="text-sm font-medium text-foreground">Client bots</h3>
			{bots === null || bots === undefined ? (
				<Waiting />
			) : bots.length === 0 ? (
				<p className="text-sm text-muted-foreground">None loaded.</p>
			) : (
				<dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
					{numbered(bots).map((bot) => (
						<Row key={bot.key} label={bot.name} value={bot.isScript ? "Script" : "Built in"} />
					))}
				</dl>
			)}
		</div>
	</div>
)

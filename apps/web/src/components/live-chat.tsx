import { renderChatJson } from "@open-mcc/contracts/boundary/chat-component"
import { MinecraftText } from "~/components/minecraft-text"
import { cn } from "~/lib/utils"

export type LiveChatEntry = {
	timestampUtc: string
	kind: "chat" | "private" | "system"
	text: string
	sender?: string | undefined
	message?: string | undefined
	json?: string | undefined
}

export type LiveChatProps = {
	entries: readonly LiveChatEntry[]
}

const KIND_LABEL: Record<LiveChatEntry["kind"], string> = {
	chat: "Chat",
	private: "Whisper",
	system: "System",
}

const KIND_CLASS: Record<LiveChatEntry["kind"], string> = {
	chat: "text-foreground",
	private: "text-primary",
	system: "text-muted-foreground",
}

const timeOf = (value: string): string => {
	const at = new Date(value)
	return Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString()
}

export const LiveChat = ({ entries }: LiveChatProps) => (
	<ol className="max-h-80 space-y-1 overflow-auto rounded-[var(--radius)] border border-border bg-card p-3 font-mono text-xs leading-relaxed">
		{entries.map((entry) => (
			<li key={`${entry.timestampUtc}:${entry.text}`} className="flex gap-2">
				<span className="shrink-0 tabular-nums text-muted-foreground">
					{timeOf(entry.timestampUtc)}
				</span>
				<span className="shrink-0 text-muted-foreground">{KIND_LABEL[entry.kind]}</span>
				<span className={cn("min-w-0 flex-1 break-words", KIND_CLASS[entry.kind])}>
					<MinecraftText value={renderChatJson(entry.json) ?? entry.text} />
				</span>
			</li>
		))}
	</ol>
)

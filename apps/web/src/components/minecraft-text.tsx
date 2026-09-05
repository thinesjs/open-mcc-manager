import { parseFormattedText } from "~/lib/minecraft-text"
import { cn } from "~/lib/utils"

export type MinecraftTextProps = {
	value: string
	className?: string
}

export const MinecraftText = ({ value, className }: MinecraftTextProps) => {
	const spans = parseFormattedText(value)
	if (spans.length === 0) return null

	return (
		<span className={className}>
			{spans.map((span, index) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: spans are positional within one immutable line
					key={index}
					className={cn(
						span.bold && "font-bold",
						span.italic && "italic",
						span.obfuscated && "blur-[3px] transition-[filter] hover:blur-none",
						span.underlined && span.strikethrough && "[text-decoration:underline_line-through]",
						span.underlined && !span.strikethrough && "underline",
						!span.underlined && span.strikethrough && "line-through",
					)}
					style={span.color === undefined ? undefined : { color: span.color }}
				>
					{span.text}
				</span>
			))}
		</span>
	)
}

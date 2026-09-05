import { useState } from "react"
import { cn } from "~/lib/utils"

export type PlayerAvatarProps = {
	username: string | null
	fallback: string
	className?: string
}

export const initialsFrom = (value: string): string => {
	const trimmed = value.trim()
	if (trimmed.length === 0) return "?"
	return trimmed.slice(0, 2).toUpperCase()
}

export const PlayerAvatar = ({ username, fallback, className }: PlayerAvatarProps) => {
	const [failed, setFailed] = useState(false)
	const shell = cn(
		"grid size-8 shrink-0 place-items-center overflow-hidden rounded-[calc(var(--radius)-2px)] border border-border bg-muted",
		className,
	)

	if (!username || failed) {
		return (
			<span className={shell} aria-hidden>
				<span className="text-[10px] font-medium text-muted-foreground">
					{initialsFrom(fallback)}
				</span>
			</span>
		)
	}

	return (
		<span className={shell}>
			<img
				src={`/avatars/${encodeURIComponent(username)}`}
				alt={`${username}'s Minecraft skin`}
				width={32}
				height={32}
				loading="lazy"
				className="size-full [image-rendering:pixelated]"
				onError={() => setFailed(true)}
			/>
		</span>
	)
}

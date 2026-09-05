import { Monitor, Moon, Sun } from "lucide-react"
import { useEffect, useState } from "react"
import {
	applyTheme,
	nextPreference,
	readStoredPreference,
	resolveTheme,
	storePreference,
	type ThemePreference,
} from "~/lib/theme"

const LABELS: Record<ThemePreference, string> = {
	system: "System theme",
	light: "Light theme",
	dark: "Dark theme",
}

const ICONS: Record<ThemePreference, typeof Sun> = {
	system: Monitor,
	light: Sun,
	dark: Moon,
}

export const ThemeToggle = () => {
	const [preference, setPreference] = useState<ThemePreference>(() =>
		readStoredPreference(window.localStorage),
	)

	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)")
		const paint = () =>
			applyTheme(document.documentElement, resolveTheme(preference, media.matches))
		paint()
		media.addEventListener("change", paint)
		return () => media.removeEventListener("change", paint)
	}, [preference])

	const Icon = ICONS[preference]

	return (
		<button
			type="button"
			aria-label={LABELS[preference]}
			title={LABELS[preference]}
			onClick={() => {
				const next = nextPreference(preference)
				setPreference(next)
				storePreference(window.localStorage, next)
			}}
			className="flex w-full items-center gap-2.5 rounded-[var(--control-radius)] px-3 py-1.5 text-sm font-medium text-sidebar-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
		>
			<Icon className="size-4" />
			{LABELS[preference]}
		</button>
	)
}

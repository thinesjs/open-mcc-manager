export type ThemePreference = "system" | "light" | "dark"

export type ResolvedTheme = "light" | "dark"

export const THEME_STORAGE_KEY = "open-mcc-theme"

export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"]

export const isThemePreference = (value: string | null): value is ThemePreference =>
	value !== null && THEME_PREFERENCES.some((preference) => preference === value)

export const resolveTheme = (preference: ThemePreference, prefersDark: boolean): ResolvedTheme => {
	if (preference === "system") return prefersDark ? "dark" : "light"
	return preference
}

export const readStoredPreference = (storage: Pick<Storage, "getItem">): ThemePreference => {
	try {
		const stored = storage.getItem(THEME_STORAGE_KEY)
		return isThemePreference(stored) ? stored : "system"
	} catch {
		return "system"
	}
}

export const storePreference = (
	storage: Pick<Storage, "setItem">,
	preference: ThemePreference,
): void => {
	try {
		storage.setItem(THEME_STORAGE_KEY, preference)
	} catch {
		return
	}
}

export const applyTheme = (root: { classList: DOMTokenList }, theme: ResolvedTheme): void => {
	root.classList.toggle("dark", theme === "dark")
}

export const nextPreference = (current: ThemePreference): ThemePreference => {
	const index = THEME_PREFERENCES.indexOf(current)
	return THEME_PREFERENCES[(index + 1) % THEME_PREFERENCES.length] ?? "system"
}

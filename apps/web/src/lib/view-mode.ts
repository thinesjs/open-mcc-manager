export const VIEW_MODES = ["cards", "list"] as const

export type ViewMode = (typeof VIEW_MODES)[number]

export const DEFAULT_VIEW_MODE: ViewMode = "cards"

export type ViewStorage = {
	getItem: (key: string) => string | null
	setItem: (key: string, value: string) => void
}

export const isViewMode = (value: string | null | undefined): value is ViewMode =>
	VIEW_MODES.some((mode) => mode === value)

export const browserStorage = (): ViewStorage | undefined => {
	try {
		if (typeof window === "undefined") return undefined
		return window.localStorage
	} catch {
		return undefined
	}
}

export const readViewMode = (key: string, storage = browserStorage()): ViewMode => {
	try {
		const stored = storage?.getItem(key)
		return isViewMode(stored) ? stored : DEFAULT_VIEW_MODE
	} catch {
		return DEFAULT_VIEW_MODE
	}
}

export const writeViewMode = (key: string, mode: ViewMode, storage = browserStorage()): void => {
	try {
		storage?.setItem(key, mode)
	} catch {}
}

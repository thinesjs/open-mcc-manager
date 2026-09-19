export const SECTION_SIGN = "§"

export const MINECRAFT_COLORS = {
	black: "#000000",
	dark_blue: "#0000aa",
	dark_green: "#00aa00",
	dark_aqua: "#00aaaa",
	dark_red: "#aa0000",
	dark_purple: "#aa00aa",
	gold: "#ffaa00",
	gray: "#aaaaaa",
	dark_gray: "#555555",
	blue: "#5555ff",
	green: "#55ff55",
	aqua: "#55ffff",
	red: "#ff5555",
	light_purple: "#ff55ff",
	yellow: "#ffff55",
	white: "#ffffff",
} as const

export type MinecraftColorName = keyof typeof MINECRAFT_COLORS

const COLOR_BY_CODE: Record<string, MinecraftColorName> = {
	"0": "black",
	"1": "dark_blue",
	"2": "dark_green",
	"3": "dark_aqua",
	"4": "dark_red",
	"5": "dark_purple",
	"6": "gold",
	"7": "gray",
	"8": "dark_gray",
	"9": "blue",
	a: "green",
	b: "aqua",
	c: "red",
	d: "light_purple",
	e: "yellow",
	f: "white",
}

export type MinecraftStyle = {
	color: string | undefined
	bold: boolean
	italic: boolean
	underlined: boolean
	strikethrough: boolean
	obfuscated: boolean
}

export type MinecraftSpan = MinecraftStyle & { text: string; start: number }

const RESET: MinecraftStyle = {
	color: undefined,
	bold: false,
	italic: false,
	underlined: false,
	strikethrough: false,
	obfuscated: false,
}

const applyCode = (style: MinecraftStyle, code: string): MinecraftStyle => {
	const colorName = COLOR_BY_CODE[code]
	if (colorName) return { ...RESET, color: MINECRAFT_COLORS[colorName] }
	switch (code) {
		case "k":
			return { ...style, obfuscated: true }
		case "l":
			return { ...style, bold: true }
		case "m":
			return { ...style, strikethrough: true }
		case "n":
			return { ...style, underlined: true }
		case "o":
			return { ...style, italic: true }
		case "r":
			return RESET
		default:
			return style
	}
}

const HEX_CODE = /^[0-9a-f]{6}$/

const readHexColor = (source: string, at: number): string | undefined => {
	if (source[at] !== "x") return undefined
	let hex = ""
	for (let index = 1; index <= 6; index += 1) {
		const offset = at + index * 2
		if (source[offset - 1] !== SECTION_SIGN) return undefined
		const digit = source[offset]
		if (digit === undefined) return undefined
		hex += digit.toLowerCase()
	}
	return HEX_CODE.test(hex) ? `#${hex}` : undefined
}

export const parseFormattedText = (source: string): MinecraftSpan[] => {
	const spans: MinecraftSpan[] = []
	let style = RESET
	let text = ""
	let start = 0

	const flush = (at: number) => {
		if (text.length === 0) {
			start = at
			return
		}
		spans.push({ ...style, text, start })
		text = ""
		start = at
	}

	for (let index = 0; index < source.length; index += 1) {
		if (source[index] !== SECTION_SIGN) {
			text += source[index]
			continue
		}
		const next = source[index + 1]
		if (next === undefined) {
			text += source[index]
			continue
		}
		const hex = readHexColor(source, index + 1)
		if (hex !== undefined) {
			flush(index + 14)
			style = { ...RESET, color: hex }
			index += 13
			continue
		}
		flush(index + 2)
		style = applyCode(style, next.toLowerCase())
		index += 1
	}
	flush(source.length)
	return spans
}

export const stripFormatting = (source: string): string =>
	parseFormattedText(source)
		.map((span) => span.text)
		.join("")

export const hasFormatting = (source: string): boolean => source.includes(SECTION_SIGN)

export type ConsoleLine = { key: number; text: string }

export const consoleLines = (output: string): ConsoleLine[] => {
	const lines: ConsoleLine[] = []
	let offset = 0
	for (const line of output.replace(/\n$/, "").split("\n")) {
		lines.push({ key: offset, text: `${line}\n` })
		offset += line.length + 1
	}
	return lines
}

import { z } from "zod"

export const CHAT_COLOR_NAMES = [
	"black",
	"dark_blue",
	"dark_green",
	"dark_aqua",
	"dark_red",
	"dark_purple",
	"gold",
	"gray",
	"dark_gray",
	"blue",
	"green",
	"aqua",
	"red",
	"light_purple",
	"yellow",
	"white",
] as const

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

const colorSchema = z.union([z.enum(CHAT_COLOR_NAMES), z.string().regex(HEX_COLOR)])

export type ChatComponent = {
	text?: string | undefined
	translate?: string | undefined
	with?: ChatComponent[] | undefined
	extra?: ChatComponent[] | undefined
	color?: string | undefined
	bold?: boolean | undefined
	italic?: boolean | undefined
	underlined?: boolean | undefined
	strikethrough?: boolean | undefined
	obfuscated?: boolean | undefined
}

const componentObject: z.ZodType<ChatComponent, z.ZodTypeDef, unknown> = z.lazy(() =>
	z.object({
		text: z.string().optional(),
		translate: z.string().optional(),
		with: z.array(componentSchema).optional(),
		extra: z.array(componentSchema).optional(),
		color: colorSchema.optional(),
		bold: z.boolean().optional(),
		italic: z.boolean().optional(),
		underlined: z.boolean().optional(),
		strikethrough: z.boolean().optional(),
		obfuscated: z.boolean().optional(),
	}),
)

export const componentSchema: z.ZodType<ChatComponent, z.ZodTypeDef, unknown> = z.lazy(() =>
	z.union([
		z.string().transform((text) => ({ text })),
		z.number().transform((value) => ({ text: String(value) })),
		z.boolean().transform((value) => ({ text: String(value) })),
		z.array(componentSchema).transform((parts) => ({ extra: parts })),
		componentObject,
	]),
)

export const parseChatComponent = (value: unknown): ChatComponent => componentSchema.parse(value)

export const safeParseChatComponent = (value: unknown): ChatComponent | undefined => {
	const result = componentSchema.safeParse(value)
	return result.success ? result.data : undefined
}

export type ChatStyle = {
	color: string | undefined
	bold: boolean
	italic: boolean
	underlined: boolean
	strikethrough: boolean
	obfuscated: boolean
}

export type ChatSpan = ChatStyle & { text: string }

const INHERITED: ChatStyle = {
	color: undefined,
	bold: false,
	italic: false,
	underlined: false,
	strikethrough: false,
	obfuscated: false,
}

export type TranslationLookup = (key: string) => string | undefined

const inherit = (parent: ChatStyle, node: ChatComponent): ChatStyle => ({
	color: node.color ?? parent.color,
	bold: node.bold ?? parent.bold,
	italic: node.italic ?? parent.italic,
	underlined: node.underlined ?? parent.underlined,
	strikethrough: node.strikethrough ?? parent.strikethrough,
	obfuscated: node.obfuscated ?? parent.obfuscated,
})

const ARGUMENT_PATTERN = /%(?:(\d+)\$)?s|%%/g

const expandTranslation = (
	template: string,
	args: ChatComponent[],
	style: ChatStyle,
	translate: TranslationLookup,
	into: ChatSpan[],
): void => {
	let cursor = 0
	let position = 0
	for (const match of template.matchAll(ARGUMENT_PATTERN)) {
		const at = match.index
		if (at > cursor) into.push({ ...style, text: template.slice(cursor, at) })
		cursor = at + match[0].length
		if (match[0] === "%%") {
			into.push({ ...style, text: "%" })
			continue
		}
		const explicit = match[1]
		const index = explicit === undefined ? position : Number(explicit) - 1
		if (explicit === undefined) position += 1
		const argument = args[index]
		if (argument !== undefined) collect(argument, style, translate, into)
	}
	if (cursor < template.length) into.push({ ...style, text: template.slice(cursor) })
}

const collect = (
	node: ChatComponent,
	parent: ChatStyle,
	translate: TranslationLookup,
	into: ChatSpan[],
): void => {
	const style = inherit(parent, node)
	if (node.text !== undefined && node.text.length > 0) {
		into.push({ ...style, text: node.text })
	}
	if (node.translate !== undefined) {
		const template = translate(node.translate)
		const args = node.with ?? []
		if (template === undefined) {
			if (args.length === 0) into.push({ ...style, text: node.translate })
			for (const argument of args) collect(argument, style, translate, into)
		} else {
			expandTranslation(template, args, style, translate, into)
		}
	}
	for (const child of node.extra ?? []) collect(child, style, translate, into)
}

export const flattenChatComponent = (
	component: ChatComponent,
	translate: TranslationLookup = () => undefined,
): ChatSpan[] => {
	const spans: ChatSpan[] = []
	collect(component, INHERITED, translate, spans)
	return spans
}

export const MAX_CHAT_COMPONENT_DEPTH = 32

const tooDeep = (value: unknown, depth: number): boolean => {
	if (depth > MAX_CHAT_COMPONENT_DEPTH) return true
	if (Array.isArray(value)) return value.some((item) => tooDeep(item, depth + 1))
	if (typeof value !== "object" || value === null) return false
	for (const nested of Object.values(value)) {
		if (tooDeep(nested, depth + 1)) return true
	}
	return false
}

export const renderChatJson = (json: string | undefined): string | undefined => {
	if (json === undefined || json.length === 0) return undefined
	try {
		const parsed: unknown = JSON.parse(json)
		if (tooDeep(parsed, 0)) return undefined
		const component = safeParseChatComponent(parsed)
		if (!component) return undefined
		const rendered = flattenChatComponent(component)
			.map((span) => span.text)
			.join("")
		return rendered.length > 0 ? rendered : undefined
	} catch {
		return undefined
	}
}

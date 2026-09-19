export type SmtpReply = {
	readonly code: number
	readonly lines: readonly string[]
}

export type ReplyRead =
	| { readonly read: true; readonly reply: SmtpReply; readonly rest: string }
	| { readonly read: false }

const LINE = /^(\d{3})([ -])(.*)$/

export const readReply = (buffer: string): ReplyRead => {
	const lines: string[] = []
	let offset = 0

	while (true) {
		const end = buffer.indexOf("\r\n", offset)
		if (end === -1) return { read: false }
		const raw = buffer.slice(offset, end)
		const match = LINE.exec(raw)
		if (!match) return { read: false }
		const [, digits, separator, text] = match
		if (digits === undefined || separator === undefined || text === undefined) {
			return { read: false }
		}
		lines.push(text)
		offset = end + 2
		if (separator === " ") {
			return {
				read: true,
				reply: { code: Number(digits), lines },
				rest: buffer.slice(offset),
			}
		}
	}
}

export const advertises = (reply: SmtpReply, keyword: string): boolean =>
	reply.lines.some((line) => {
		const word = line.trim().split(/\s+/)[0]
		return word !== undefined && word.toUpperCase() === keyword.toUpperCase()
	})

export const authMechanisms = (reply: SmtpReply): readonly string[] =>
	reply.lines.flatMap((line) => {
		const parts = line.trim().split(/\s+/)
		const head = parts[0]
		return head !== undefined && head.toUpperCase() === "AUTH"
			? parts.slice(1).map((mechanism) => mechanism.toUpperCase())
			: []
	})

export const isPositive = (reply: SmtpReply): boolean => reply.code >= 200 && reply.code < 400

export const isTransient = (code: number): boolean => code >= 400 && code < 500

const PRINTABLE = /^[\x20-\x7e]*$/

const BASE64_LINE = /(.{76})/g

export const encodedWord = (value: string): string =>
	PRINTABLE.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`

export const wrappedBase64 = (value: string): string =>
	Buffer.from(value, "utf8").toString("base64").replace(BASE64_LINE, "$1\r\n")

export const domainOf = (address: string): string => {
	const at = address.lastIndexOf("@")
	return at === -1 ? "openmcc.invalid" : address.slice(at + 1)
}

export type SmtpMessage = {
	readonly id: string
	readonly from: string
	readonly to: readonly string[]
	readonly subject: string
	readonly text: string
	readonly at: Date
}

export const messageBytes = (message: SmtpMessage): string =>
	[
		`From: ${message.from}`,
		`To: ${message.to.join(", ")}`,
		`Subject: ${encodedWord(message.subject)}`,
		`Date: ${message.at.toUTCString()}`,
		`Message-ID: <${message.id}@${domainOf(message.from)}>`,
		"MIME-Version: 1.0",
		'Content-Type: text/plain; charset="utf-8"',
		"Content-Transfer-Encoding: base64",
		"",
		wrappedBase64(message.text),
	].join("\r\n")

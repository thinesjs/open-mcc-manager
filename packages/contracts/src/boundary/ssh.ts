import { createHash } from "node:crypto"
import { z } from "zod"

const hostKeySchema = z.object({
	algorithm: z.string().min(1),
	fingerprint: z.string().min(1),
})

export type HostKey = z.infer<typeof hostKeySchema>

export const parseHostKey = (value: unknown): HostKey => hostKeySchema.parse(value)

export const fingerprintFromKey = (key: Buffer): string =>
	`SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`

const isAllowedSshNameByte = (byte: number): boolean =>
	(byte >= 0x30 && byte <= 0x39) ||
	(byte >= 0x41 && byte <= 0x5a) ||
	(byte >= 0x61 && byte <= 0x7a) ||
	byte === 0x2d ||
	byte === 0x2e ||
	byte === 0x40

export const algorithmFromKey = (key: Buffer): string => {
	if (key.length < 4) {
		throw new Error("Host key blob is too short to contain an algorithm name")
	}
	const length = key.readUInt32BE(0)
	if (length === 0) {
		throw new Error("Host key blob declares an empty algorithm name")
	}
	if (length > key.length - 4) {
		throw new Error("Host key blob declares an algorithm length exceeding the buffer")
	}
	const nameBytes = key.subarray(4, 4 + length)
	for (const byte of nameBytes) {
		if (!isAllowedSshNameByte(byte)) {
			throw new Error("Host key blob declares an algorithm name outside the allowed character set")
		}
	}
	return nameBytes.toString("ascii")
}

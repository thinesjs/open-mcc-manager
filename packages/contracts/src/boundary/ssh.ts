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
	return key.subarray(4, 4 + length).toString("ascii")
}

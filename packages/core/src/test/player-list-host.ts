import { createHash } from "node:crypto"
import { createFakeTransport, type FakeScript } from "@open-mcc/transport"
import {
	fingerprintWindow,
	MAX_ARTIFACT_BYTES,
	playerListReadCommand,
	truncateCommand,
} from "../instance/artifact"

const STOPPED = new Set(["inactive", "failed"])

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")

export const fingerprintOf = (content: Buffer, end: number): string => {
	const { skip, count } = fingerprintWindow(end)
	return sha256(content.subarray(skip, skip + count))
}

export const playerListOutput = (
	content: Buffer | undefined,
	unit: string,
	auth: string,
	offset: number,
): string => {
	const bytes = content ?? Buffer.alloc(0)
	const size = content?.length
	const length =
		size !== undefined && size >= offset ? Math.min(size - offset, MAX_ARTIFACT_BYTES) : 0
	return [
		`size=${size ?? ""}`,
		`unit=${unit}`,
		`auth=${auth}`,
		`before=${fingerprintOf(bytes, offset)}`,
		`chunk=${bytes.subarray(offset, offset + length).toString("base64")}`,
		`after=${fingerprintOf(bytes, offset + length)}`,
		"",
	].join("\n")
}

export type PlayerListHost = {
	content: Buffer | undefined
	unit: string
	auth: string
	readonly transport: ReturnType<typeof createFakeTransport>
	readonly truncations: () => number
}

const numbersIn = (command: string): readonly number[] =>
	[...new Set(command.match(/\d+/g) ?? [])].map(Number)

export const createPlayerListHost = (
	instanceId: string,
	name: string,
	initial: { content: Buffer | undefined; unit: string; auth: string },
	script: FakeScript = {},
): PlayerListHost => {
	const transport = createFakeTransport(script)
	let truncated = 0
	const host: PlayerListHost = {
		...initial,
		transport,
		truncations: () => truncated,
	}
	const scripted = transport.exec
	transport.exec = async (command: string, timeoutMs: number, stdin?: string) => {
		for (const offset of numbersIn(command)) {
			if (command === playerListReadCommand(instanceId, name, offset)) {
				transport.commands.push(command)
				return {
					stdout: playerListOutput(host.content, host.unit, host.auth, offset),
					stderr: "",
					exitCode: 0,
				}
			}
			for (const fingerprint of command.match(/[0-9a-f]{64}/g) ?? []) {
				if (command !== truncateCommand(instanceId, name, { offset, fingerprint })) continue
				transport.commands.push(command)
				const content = host.content
				const unchanged =
					content !== undefined &&
					content.length === offset &&
					fingerprintOf(content, offset) === fingerprint
				if (!STOPPED.has(host.unit) || !STOPPED.has(host.auth) || !unchanged) {
					return { stdout: "", stderr: "", exitCode: 1 }
				}
				host.content = Buffer.alloc(0)
				truncated += 1
				return { stdout: "", stderr: "", exitCode: 0 }
			}
		}
		return await scripted(command, timeoutMs, stdin)
	}
	return host
}

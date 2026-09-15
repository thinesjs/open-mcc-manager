import type { Duplex } from "node:stream"

export type ConnectionState = "disconnected" | "connecting" | "ready" | "degraded" | "failed"

export type ExecResult = {
	stdout: string
	stderr: string
	exitCode: number
}

export type ConnectOptions = {
	hostname: string
	port: number
	username: string
	privateKey: string
	expectedFingerprint: string
	timeoutMs: number
}

export type ForwardedStream = {
	socket: Duplex
	close: () => void
}

export type HostTransport = {
	state: () => ConnectionState
	connect: (options: ConnectOptions) => Promise<void>
	exec: (command: string, timeoutMs: number, stdin?: string) => Promise<ExecResult>
	canForward: (port: number, timeoutMs: number) => Promise<boolean>
	forward: (port: number, timeoutMs: number) => Promise<ForwardedStream>
	close: () => Promise<void>
}

export type ReusableTransport = HostTransport & {
	destroy: () => void
	execUntil: (command: string, signal: AbortSignal) => Promise<ExecResult>
	forwardUntil: (port: number, signal: AbortSignal) => Promise<ForwardedStream>
}

export class LiveChannelUnavailableError extends Error {}

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

export type HostTransport = {
	state: () => ConnectionState
	connect: (options: ConnectOptions) => Promise<void>
	exec: (command: string, timeoutMs: number) => Promise<ExecResult>
	close: () => Promise<void>
}

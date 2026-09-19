export {
	ChannelOpenTimedOutError,
	ChannelQueueExpiredError,
	CommandTimedOutError,
	ForwardTimedOutError,
	ReadConnectionLostError,
	ReadDeadlineExceededError,
	TransportInterruptedError,
} from "./errors"
export type { FakeFailures, FakeRootSession, FakeRootSessionScript, FakeScript } from "./fake"
export { createFakeRootSession, createFakeTransport, readerOver } from "./fake"
export type {
	ConnectionIdentity,
	HostReader,
	OpenConnection,
	ReadCommand,
	ReadConnections,
	ReadConnectionsOptions,
} from "./read-connections"
export {
	asReadCommand,
	createReadConnections,
	READ_CONNECTION_CHANNEL_LIMIT,
	READ_CONNECTION_HARD_AGE_MS,
	READ_CONNECTION_IDLE_MS,
	readCommandText,
	sameConnectionIdentity,
} from "./read-connections"
export { createSshTransport } from "./ssh/connection"
export {
	ChannelLimitReachedError,
	CommandAbortedError,
	MAX_STDOUT_BYTES,
	StreamOverflowError,
} from "./ssh/exec"
export type { SshHandshake } from "./ssh/probe"
export { probeHostKey, probeSshHandshake } from "./ssh/probe"
export type {
	RootClient,
	RootClientSettings,
	RootCredential,
	RootSession,
	RootSessionOptions,
} from "./ssh/root-session"
export {
	createRootSession,
	RootHostKeyRejectedError,
	SETUP_SCRIPT_LABEL,
} from "./ssh/root-session"
export type { VerificationResult } from "./ssh/verify"
export { verifyHostKey } from "./ssh/verify"
export type * from "./types"
export type { ForwardedStream } from "./types"
export { LiveChannelUnavailableError } from "./types"

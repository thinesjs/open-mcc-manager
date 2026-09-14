import { LiveChannelUnavailableError } from "./types"

export class TransportInterruptedError extends Error {}

export class CommandTimedOutError extends TransportInterruptedError {}

export class ChannelOpenTimedOutError extends TransportInterruptedError {}

export class ChannelQueueExpiredError extends TransportInterruptedError {}

export class ReadDeadlineExceededError extends TransportInterruptedError {}

export class ReadConnectionLostError extends TransportInterruptedError {}

export class ForwardTimedOutError extends LiveChannelUnavailableError {}

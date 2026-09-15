import { INSTANCE_ID_PATTERN } from "@open-mcc/contracts"
import { INSTANCES_ROOT, systemctl } from "../host/profile"

export type EnvironmentValues = {
	liveControlToken: string
}

export const INSTANCE_LAYOUT = {
	config: "config",
	state: "state",
	replays: "replays",
	recordingCache: "recording-cache",
	unitEnv: "unit.env",
	env: "env",
	control: "control",
	collectLock: "collect.lock",
} as const

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

export const validateInstanceId = (id: string): string => {
	if (id.includes("%")) {
		throw new Error("Instance id must not contain '%', which systemd expands as a specifier")
	}
	if (!INSTANCE_ID_PATTERN.test(id)) {
		throw new Error("Instance id must be 1-64 characters of letters, digits, '-' and '_'")
	}
	return id
}

export const LIVE_CONTROL_TOKEN_ENV = "MCC_MCP_AUTH_TOKEN"

const LIVE_CONTROL_TOKEN = /^[0-9a-f]{32}$/

export const renderEnvironmentFile = (values: EnvironmentValues): string => {
	if (!LIVE_CONTROL_TOKEN.test(values.liveControlToken)) {
		throw new Error("The live control token must be 32 lowercase hex characters")
	}
	return `${LIVE_CONTROL_TOKEN_ENV}=${values.liveControlToken}\n`
}

const PORT_DIGITS = /^[1-9][0-9]{0,4}$/

export const renderUnitEnv = (port: number): string => {
	const digits = String(port)
	if (!PORT_DIGITS.test(digits) || port > 65535) {
		throw new Error("The live control port must be a whole number from 1 to 65535")
	}
	return `OPEN_MCC_PORT=${digits}\n`
}

export const unitName = (instanceId: string): string => `open-mcc@${validateInstanceId(instanceId)}`

export const authUnitName = (instanceId: string): string =>
	`open-mcc-auth@${validateInstanceId(instanceId)}.service`

export const stopAuthCommand = (instanceId: string): string => {
	const unit = shellQuote(authUnitName(instanceId))
	return `${systemctl(`stop ${unit}`)} || true; ${systemctl(`reset-failed ${unit}`)} || true`
}

export const instanceDir = (instanceId: string): string =>
	`${INSTANCES_ROOT}/instances/${validateInstanceId(instanceId)}`

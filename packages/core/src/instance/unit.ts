import { INSTANCE_ID_PATTERN } from "@open-mcc/contracts"
import { type HostProfile, systemctl } from "../host/profile"

export type EnvironmentValues = {
	liveControlToken: string
}

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

const environmentValue = (value: string): string => {
	if (/[\n\r]/.test(value)) throw new Error("Environment values must not contain newlines")
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

export const LIVE_CONTROL_TOKEN_ENV = "MCC_MCP_AUTH_TOKEN"

export const renderEnvironmentFile = (values: EnvironmentValues): string =>
	[`${LIVE_CONTROL_TOKEN_ENV}=${environmentValue(values.liveControlToken)}`, ""].join("\n")

export const unitName = (instanceId: string): string => `open-mcc@${validateInstanceId(instanceId)}`

export const authUnitName = (instanceId: string): string =>
	`open-mcc-auth@${validateInstanceId(instanceId)}.service`

export const stopAuthCommand = (profile: HostProfile, instanceId: string): string => {
	const unit = shellQuote(authUnitName(instanceId))
	return `${systemctl(profile, `stop ${unit}`)} || true; ${systemctl(
		profile,
		`reset-failed ${unit}`,
	)} || true`
}

export const instanceDir = (instancesRoot: string, instanceId: string): string =>
	`${instancesRoot}/instances/${validateInstanceId(instanceId)}`

export const instanceUser = (instanceId: string): string => `mcc-${validateInstanceId(instanceId)}`

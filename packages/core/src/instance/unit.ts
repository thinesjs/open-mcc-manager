import { INSTANCE_ID_PATTERN } from "@open-mcc/contracts"

export type EnvironmentValues = {
	serverAddress: string
	minecraftAccount: string
}

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

export const renderEnvironmentFile = (values: EnvironmentValues): string =>
	[
		`MCC_SERVER=${environmentValue(values.serverAddress)}`,
		`MCC_ACCOUNT=${environmentValue(values.minecraftAccount)}`,
		"",
	].join("\n")

export const unitName = (instanceId: string): string => `open-mcc@${validateInstanceId(instanceId)}`

export const instanceDir = (instancesRoot: string, instanceId: string): string =>
	`${instancesRoot}/instances/${validateInstanceId(instanceId)}`

export const instanceUser = (instanceId: string): string => `mcc-${validateInstanceId(instanceId)}`

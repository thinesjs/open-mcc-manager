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

export const CONFIG_FILE_NAME = "MinecraftClient.ini"

export const CONFIG_FILE_PATH = `${INSTANCE_LAYOUT.config}/${CONFIG_FILE_NAME}`

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

export type InstanceLayoutValues = {
	instanceId: string
	liveControlPort: number
	liveControlToken: string
	configDocument: string
}

export const instanceLayoutSteps = ({
	instanceId,
	liveControlPort,
	liveControlToken,
	configDocument,
}: InstanceLayoutValues) => {
	const dir = instanceDir(instanceId)
	const { config, state, replays, recordingCache, unitEnv, env, control, collectLock } =
		INSTANCE_LAYOUT
	return [
		{
			command: `install -d -m 0700 ${dir} ${dir}/${config} ${dir}/${state} ${dir}/${replays} ${dir}/${recordingCache}`,
			failure: "Failed to create the instance directories",
			stdin: undefined,
		},
		{
			command: `(test -p ${dir}/${control} || mkfifo -m 0600 ${dir}/${control}) && (umask 077; : > ${dir}/${collectLock} && printf '%s' ${shellQuote(renderUnitEnv(liveControlPort))} > ${dir}/${unitEnv})`,
			failure: "Failed to create the control fifo, the collector lock and the port file",
			stdin: undefined,
		},
		{
			command: `(umask 077; cat > ${dir}/${env})`,
			failure: "Failed to write the instance environment",
			stdin: renderEnvironmentFile({ liveControlToken }),
		},
		{
			command: `(umask 077; cat > ${dir}/${CONFIG_FILE_PATH})`,
			failure: "Failed to write the instance config",
			stdin: configDocument,
		},
	]
}

export const startUnitCommand = (instanceId: string): string => {
	const unit = shellQuote(unitName(instanceId))
	return `${systemctl(`start ${unit}`)} && ${systemctl(`show -p ActiveState -p Result ${unit}`)}`
}

const UNIT_START_LINE = /^(ActiveState|Result)=([a-z][a-z-]*)$/

export const parseUnitStartState = (output: string) => {
	const lines = (output.endsWith("\n") ? output.slice(0, -1) : output).split("\n")
	if (lines.length !== 2) return undefined
	const values = new Map<string, string>()
	for (const line of lines) {
		const match = UNIT_START_LINE.exec(line)
		if (match === null) return undefined
		const [, key = "", value = ""] = match
		if (values.has(key)) return undefined
		values.set(key, value)
	}
	const activeState = values.get("ActiveState")
	const result = values.get("Result")
	return activeState === undefined || result === undefined ? undefined : { activeState, result }
}

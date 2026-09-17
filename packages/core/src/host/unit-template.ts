import type { NetworkStack } from "@open-mcc/contracts"
import { INSTANCE_LAYOUT, RUNNING_UNIT_STATES } from "../instance/unit"
import { INSTANCES_PATH } from "./profile"

export const INSTANCE_UNIT_NAME = "open-mcc@.service"

export const SLEEP_STOP_UNIT_NAME = "open-mcc-sleep-stop@.service"

export const SLEEP_START_UNIT_NAME = "open-mcc-sleep-start@.service"

export const AUTH_UNIT_NAME = "open-mcc-auth@.service"

export const QUIT_WRITE_TIMEOUT_SECONDS = 5

export const SLEEP_UNIT_NAMES = [SLEEP_STOP_UNIT_NAME, SLEEP_START_UNIT_NAME] as const

export const SUPPORTING_UNIT_NAMES = [
	SLEEP_STOP_UNIT_NAME,
	SLEEP_START_UNIT_NAME,
	AUTH_UNIT_NAME,
] as const

export type UnitRuntime = {
	networkStack: NetworkStack
	imageId: string
}

const ROOT = `%h/${INSTANCES_PATH}`

const DIR = `${ROOT}/instances/%i`

const { config, state, replays, recordingCache, unitEnv, env, control, collectLock } =
	INSTANCE_LAYOUT

const NETWORK: Readonly<Record<NetworkStack, string>> = {
	slirp4netns: "slirp4netns:port_handler=slirp4netns",
	pasta: "pasta",
}

const PODMAN_IMAGE_ID = /^[0-9a-f]{64}$/

const PORT = "$${OPEN_MCC_PORT}"

const skipWhileActive = (unit: string): string =>
	`ExecCondition=/bin/sh -c 'case "$$(systemctl --user show -p ActiveState --value ${unit})" in ${RUNNING_UNIT_STATES.join("|")}) exit 1;; esac'`

const CONFIG_PREFLIGHT = `ExecStartPre=/bin/sh -c 'f="${DIR}/${config}/MinecraftClient.ini"; [ ! -L "$$f" ] && [ -f "$$f" ] && [ -s "$$f" ] && [ -r "$$f" ] || { echo "open-mcc: the saved settings file is missing or unreadable" >&2; exit 1; }'`

const sleepExec = (verb: string): string => `/usr/bin/systemctl --user ${verb} open-mcc@%i.service`

const instanceUnit = (network: string, imageId: string): string => `[Unit]
Description=open-mcc-manager instance %i
StartLimitIntervalSec=600
StartLimitBurst=5
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
Delegate=yes
EnvironmentFile=${DIR}/${unitEnv}
WorkingDirectory=${DIR}
${skipWhileActive("open-mcc-auth@%i.service")}
${CONFIG_PREFLIGHT}
ExecStartPre=/usr/bin/flock -w 30 "${DIR}/${collectLock}" /bin/sh -c 'rm -rf -- "${DIR}/${recordingCache}" && mkdir -m 0700 "${DIR}/${recordingCache}"'
ExecStart=/bin/sh -c 'exec 3<>"${DIR}/${control}"; exec /usr/bin/podman run --replace --rm -d -i --pull=never --sdnotify=conmon --cgroups=split --log-driver=passthrough --init --name open-mcc-%i --user 0:0 --read-only --cap-drop=all --security-opt=no-new-privileges --env-file="${DIR}/${env}" -e DOTNET_BUNDLE_EXTRACT_BASE_DIR=/data -v ${ROOT}/bin:/opt/mcc:ro -v "${DIR}/${config}":/config:ro -v "${DIR}/${state}":/data -v "${DIR}/${replays}":/data/replay_recordings -v "${DIR}/${recordingCache}":/data/recording_cache -w /data --network=${network} -p 127.0.0.1:${PORT}:${PORT} ${imageId} /opt/mcc/MinecraftClient /config/MinecraftClient.ini BasicIO <&3'
ExecStop=/bin/sh -c '[ -z "$$MAINPID" ] || { timeout ${QUIT_WRITE_TIMEOUT_SECONDS} sh -c "echo /quit > \\"${DIR}/${control}\\"" && while kill -0 $$MAINPID 2>/dev/null; do sleep 1; done; }'
StandardOutput=journal
StandardError=journal
TimeoutStopSec=20
Restart=on-failure
RestartPreventExitStatus=4
RestartSec=30

[Install]
WantedBy=default.target
`

const signInUnit = (network: string, imageId: string): string => `[Unit]
Description=open-mcc-manager sign-in for instance %i
JobTimeoutSec=55

[Service]
Type=notify
NotifyAccess=all
Delegate=yes
WorkingDirectory=${DIR}
${skipWhileActive("open-mcc@%i.service")}
${CONFIG_PREFLIGHT}
ExecStartPre=/usr/bin/flock -w 30 "${DIR}/${collectLock}" /bin/true
ExecStart=/bin/sh -c 'exec /usr/bin/podman run --replace --rm -d --pull=never --sdnotify=conmon --cgroups=split --log-driver=passthrough --init --name open-mcc-auth-%i --user 0:0 --read-only --cap-drop=all --security-opt=no-new-privileges -e DOTNET_BUNDLE_EXTRACT_BASE_DIR=/data -v ${ROOT}/bin:/opt/mcc:ro -v "${DIR}/${config}":/config:ro -v "${DIR}/${state}":/data -w /data --network=${network} ${imageId} /opt/mcc/MinecraftClient /config/MinecraftClient.ini BasicIO-NoColor </dev/null >"${DIR}/auth.log" 2>&1'
TimeoutStartSec=20
TimeoutStopSec=10
`

export const renderUnitTemplates = ({
	networkStack,
	imageId,
}: UnitRuntime): Record<string, string> => {
	if (!PODMAN_IMAGE_ID.test(imageId)) {
		throw new Error("The runtime image ID must be the 64 hex characters Podman prints")
	}
	const network = NETWORK[networkStack]
	return {
		[INSTANCE_UNIT_NAME]: instanceUnit(network, imageId),
		[AUTH_UNIT_NAME]: signInUnit(network, imageId),
		[SLEEP_STOP_UNIT_NAME]: `[Unit]
Description=Stop open-mcc instance %i for its sleep window

[Service]
Type=oneshot
ExecStart=${sleepExec("stop")}
`,
		[SLEEP_START_UNIT_NAME]: `[Unit]
Description=Start open-mcc instance %i after its sleep window

[Service]
Type=oneshot
ExecStart=${sleepExec("start")}
`,
	}
}

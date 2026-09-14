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

const ROOT = `%h/${INSTANCES_PATH}`

const DIR = `${ROOT}/instances/%i`

const SIBLING_ISOLATION = `ProtectHome=tmpfs\nBindReadOnlyPaths=${ROOT}/bin\nBindPaths=${DIR}\n`

const sleepExec = (verb: string): string => `/usr/bin/systemctl --user ${verb} open-mcc@%i.service`

export const renderUnitTemplates = (): Record<string, string> => ({
	[INSTANCE_UNIT_NAME]: `[Unit]
Description=open-mcc-manager instance %i
StartLimitIntervalSec=600
StartLimitBurst=5
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${DIR}
EnvironmentFile=${DIR}/env
ExecStart=/bin/sh -c 'exec 3<>"${DIR}/control"; exec "${ROOT}/bin/MinecraftClient" BasicIO <&3'
ExecStop=/bin/sh -c '[ -z "$$MAINPID" ] || { timeout ${QUIT_WRITE_TIMEOUT_SECONDS} sh -c "echo /quit > ${DIR}/control" && while kill -0 $$MAINPID 2>/dev/null; do sleep 1; done; }'
StandardOutput=journal
StandardError=journal
TimeoutStopSec=20
Restart=on-failure
RestartPreventExitStatus=4
RestartSec=30
NoNewPrivileges=yes
UMask=0077
ProtectSystem=strict
${SIBLING_ISOLATION}PrivateTmp=yes
ReadWritePaths=${DIR}

[Install]
WantedBy=default.target
`,
	[AUTH_UNIT_NAME]: `[Unit]
Description=open-mcc-manager sign-in for instance %i

[Service]
Type=simple
WorkingDirectory=${DIR}
ExecStart=/bin/sh -c 'exec "${ROOT}/bin/MinecraftClient" BasicIO-NoColor > ${DIR}/auth.log 2>&1'
StandardInput=null
StandardOutput=journal
StandardError=journal
TimeoutStopSec=10
NoNewPrivileges=yes
UMask=0077
ProtectSystem=strict
${SIBLING_ISOLATION}PrivateTmp=yes
ReadWritePaths=${DIR}
`,
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
})

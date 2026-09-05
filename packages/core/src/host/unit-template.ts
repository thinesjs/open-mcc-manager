import { type HostProfile, installTarget, usesPerInstanceUsers } from "./profile"

export const INSTANCE_UNIT_NAME = "open-mcc@.service"

export const SLEEP_STOP_UNIT_NAME = "open-mcc-sleep-stop@.service"

export const SLEEP_START_UNIT_NAME = "open-mcc-sleep-start@.service"

export const SLEEP_UNIT_NAMES = [SLEEP_STOP_UNIT_NAME, SLEEP_START_UNIT_NAME] as const

const identity = (profile: HostProfile): string =>
	usesPerInstanceUsers(profile) ? "User=mcc-%i\nGroup=mcc-%i\n" : ""

const homeProtection = (profile: HostProfile): string =>
	usesPerInstanceUsers(profile) ? "ProtectHome=yes\n" : ""

const sleepExec = (profile: HostProfile, verb: string): string =>
	profile.mode === "rootless"
		? `/usr/bin/systemctl --user ${verb} open-mcc@%i.service`
		: `/usr/bin/systemctl ${verb} open-mcc@%i.service`

export const renderUnitTemplates = (profile: HostProfile): Record<string, string> => {
	const dir = `${profile.instancesRoot}/instances/%i`
	return {
		[INSTANCE_UNIT_NAME]: `[Unit]
Description=open-mcc-manager instance %i
StartLimitIntervalSec=600
StartLimitBurst=5
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${identity(profile)}WorkingDirectory=${dir}
EnvironmentFile=${dir}/env
ExecStart=/bin/sh -c 'exec 3<>"${dir}/control"; exec "${profile.instancesRoot}/bin/MinecraftClient" BasicIO-NoColor <&3'
ExecStop=/bin/sh -c 'printf "/quit\\n" > ${dir}/control'
StandardOutput=journal
StandardError=journal
TimeoutStopSec=30
Restart=on-failure
RestartPreventExitStatus=4
RestartSec=30
NoNewPrivileges=yes
UMask=0077
ProtectSystem=strict
${homeProtection(profile)}PrivateTmp=yes
ReadWritePaths=${dir}

[Install]
WantedBy=${installTarget(profile)}
`,
		[SLEEP_STOP_UNIT_NAME]: `[Unit]
Description=Stop open-mcc instance %i for its sleep window

[Service]
Type=oneshot
ExecStart=${sleepExec(profile, "stop")}
`,
		[SLEEP_START_UNIT_NAME]: `[Unit]
Description=Start open-mcc instance %i after its sleep window

[Service]
Type=oneshot
ExecStart=${sleepExec(profile, "start")}
`,
	}
}

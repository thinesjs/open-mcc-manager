import { type HostProfile, installTarget, usesPerInstanceUsers } from "./profile"

export const INSTANCE_UNIT_NAME = "open-mcc@.service"

export const SLEEP_STOP_UNIT_NAME = "open-mcc-sleep-stop@.service"

export const SLEEP_START_UNIT_NAME = "open-mcc-sleep-start@.service"

export const AUTH_UNIT_NAME = "open-mcc-auth@.service"

export const SLEEP_UNIT_NAMES = [SLEEP_STOP_UNIT_NAME, SLEEP_START_UNIT_NAME] as const

export const SUPPORTING_UNIT_NAMES = [
	SLEEP_STOP_UNIT_NAME,
	SLEEP_START_UNIT_NAME,
	AUTH_UNIT_NAME,
] as const

const identity = (profile: HostProfile): string =>
	usesPerInstanceUsers(profile) ? "User=mcc-%i\nGroup=mcc-%i\n" : ""

const homeProtection = (profile: HostProfile): string =>
	usesPerInstanceUsers(profile) ? "ProtectHome=yes\n" : ""

const siblingIsolation = (profile: HostProfile, dir: string): string =>
	usesPerInstanceUsers(profile)
		? ""
		: `ProtectHome=tmpfs\nBindReadOnlyPaths=${profile.instancesRoot}/bin\nBindPaths=${dir}\n`

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
ExecStart=/bin/sh -c 'exec 3<>"${dir}/control"; exec "${profile.instancesRoot}/bin/MinecraftClient" BasicIO <&3'
ExecStop=/bin/sh -c '[ -z "$$MAINPID" ] || { timeout 5 sh -c "echo /quit > ${dir}/control" && while kill -0 $$MAINPID 2>/dev/null; do sleep 1; done; }'
StandardOutput=journal
StandardError=journal
TimeoutStopSec=20
Restart=on-failure
RestartPreventExitStatus=4
RestartSec=30
NoNewPrivileges=yes
UMask=0077
ProtectSystem=strict
${homeProtection(profile)}${siblingIsolation(profile, dir)}PrivateTmp=yes
ReadWritePaths=${dir}

[Install]
WantedBy=${installTarget(profile)}
`,
		[AUTH_UNIT_NAME]: `[Unit]
Description=open-mcc-manager sign-in for instance %i

[Service]
Type=simple
${identity(profile)}WorkingDirectory=${dir}
ExecStart=/bin/sh -c 'exec "${profile.instancesRoot}/bin/MinecraftClient" BasicIO-NoColor > ${dir}/auth.log 2>&1'
StandardInput=null
StandardOutput=journal
StandardError=journal
TimeoutStopSec=10
NoNewPrivileges=yes
UMask=0077
ProtectSystem=strict
${homeProtection(profile)}${siblingIsolation(profile, dir)}PrivateTmp=yes
ReadWritePaths=${dir}
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

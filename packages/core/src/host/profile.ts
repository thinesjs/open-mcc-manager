export const HOST_MODES = ["rootless", "system"] as const

export type HostMode = (typeof HOST_MODES)[number]

export type HostProfile = {
	mode: HostMode
	instancesRoot: string
	unitDir: string
}

export const SYSTEM_INSTANCES_ROOT = "/srv/open-mcc"

export const SYSTEM_UNIT_DIR = "/etc/systemd/system"

export const ROOTLESS_INSTANCES_SUFFIX = ".local/share/open-mcc"

export const ROOTLESS_UNIT_SUFFIX = ".config/systemd/user"

const PATH_PATTERN = /^\/[A-Za-z0-9._\-/]*$/

export const validateHostPath = (value: string, label: string): string => {
	if (!PATH_PATTERN.test(value)) {
		throw new Error(
			`${label} must be an absolute path containing only letters, digits, '.', '_', '-', and '/'`,
		)
	}
	return value
}

export const systemProfile = (): HostProfile => ({
	mode: "system",
	instancesRoot: SYSTEM_INSTANCES_ROOT,
	unitDir: SYSTEM_UNIT_DIR,
})

export const rootlessProfile = (home: string): HostProfile => {
	const base = validateHostPath(home, "The remote home directory").replace(/\/+$/, "")
	return {
		mode: "rootless",
		instancesRoot: `${base}/${ROOTLESS_INSTANCES_SUFFIX}`,
		unitDir: `${base}/${ROOTLESS_UNIT_SUFFIX}`,
	}
}

export const profileFrom = (
	mode: HostMode,
	instancesRoot: string,
	unitDir: string,
): HostProfile => ({
	mode,
	instancesRoot: validateHostPath(instancesRoot, "The instances root"),
	unitDir: validateHostPath(unitDir, "The unit directory"),
})

const RUNTIME_DIR_PREFIX = "XDG_RUNTIME_DIR=/run/user/$(id -u) "

export const systemctl = (profile: HostProfile, args: string): string =>
	profile.mode === "rootless"
		? `${RUNTIME_DIR_PREFIX}systemctl --user ${args}`
		: `systemctl ${args}`

export const journalctl = (profile: HostProfile, args: string): string =>
	profile.mode === "rootless"
		? `${RUNTIME_DIR_PREFIX}journalctl --user ${args}`
		: `journalctl ${args}`

export const usesPerInstanceUsers = (profile: HostProfile): boolean => profile.mode === "system"

export const installTarget = (profile: HostProfile): string =>
	profile.mode === "rootless" ? "default.target" : "multi-user.target"

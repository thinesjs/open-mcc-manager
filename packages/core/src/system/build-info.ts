export const DEV_VERSION = "0.0.0-dev"

export const UNKNOWN_COMMIT = "unknown"

export type BuildInfo = {
	version: string
	commit: string
}

export type BuildEnv = {
	APP_VERSION?: string | undefined
	GIT_SHA?: string | undefined
}

const clean = (value: string | undefined, fallback: string): string => {
	const trimmed = (value ?? "").trim()
	return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : fallback
}

export const readBuildInfo = (env: BuildEnv): BuildInfo => ({
	version: clean(env.APP_VERSION, DEV_VERSION),
	commit: clean(env.GIT_SHA, UNKNOWN_COMMIT).slice(0, 12),
})

export const isDevelopmentBuild = (info: BuildInfo): boolean =>
	info.version === DEV_VERSION || info.commit === UNKNOWN_COMMIT

export const sameBuild = (left: BuildInfo, right: BuildInfo): boolean =>
	left.version === right.version && left.commit === right.commit

export const describeBuild = (info: BuildInfo): string =>
	info.commit === UNKNOWN_COMMIT ? info.version : `${info.version} (${info.commit})`

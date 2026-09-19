import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { HASHED_ASSETS } from "../static-app"

export const BUILD_TIMEOUT_MS = 300_000

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../..", import.meta.url))

const DASHBOARD_DIST = path.join(REPOSITORY_ROOT, "apps", "web", "dist")

export type BuiltDashboard = {
	root: string
	shell: string
	hashedAsset: string
}

export const builtDashboard = async (): Promise<BuiltDashboard> => {
	if (!existsSync(path.join(DASHBOARD_DIST, "index.html"))) {
		await promisify(execFile)("pnpm", ["--filter", "@open-mcc/web", "build"], {
			cwd: REPOSITORY_ROOT,
			timeout: BUILD_TIMEOUT_MS,
		})
	}
	const shell = await readFile(path.join(DASHBOARD_DIST, "index.html"), "utf8")
	const built = await readdir(path.join(DASHBOARD_DIST, "assets"))
	const asset = built.find((name) => name.endsWith(".js"))
	if (asset === undefined) {
		throw new Error(`the dashboard build under ${DASHBOARD_DIST} carries no hashed script`)
	}
	return { root: DASHBOARD_DIST, shell, hashedAsset: `${HASHED_ASSETS}${asset}` }
}

import fs from "node:fs"
import path from "node:path"

const root = process.cwd()

const DOCKERFILES = ["docker/server/Dockerfile", "docker/worker/Dockerfile"]

const BUNDLED_WHOLE = ["docker/web/Dockerfile"]

const PRUNE_SCRIPT = "docker/server/prune-deploy.mjs"

export const externalsIn = (dockerfile) => {
	const found = new Set()
	for (const match of dockerfile.matchAll(/--external:([^\s\\]+)/g)) {
		const name = match[1]
		if (name === undefined) continue
		const base = name.endsWith("/*") ? name.slice(0, -2) : name
		if (base.length > 0) found.add(base)
	}
	return found
}

export const shippedIn = (pruneScript) => {
	const block = pruneScript.match(/const runtimeRoots = \[([\s\S]*?)\]/)
	const body = block?.[1] ?? ""
	return new Set(
		[...body.matchAll(/"([^"]+)"/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]])),
	)
}

export const missing = (externals, shipped) => [...externals].filter((name) => !shipped.has(name))

const main = () => {
	const shipped = shippedIn(fs.readFileSync(path.join(root, PRUNE_SCRIPT), "utf8"))
	const problems = []
	for (const file of DOCKERFILES) {
		const externals = externalsIn(fs.readFileSync(path.join(root, file), "utf8"))
		for (const name of missing(externals, shipped)) {
			problems.push(`${file} marks ${name} external, but ${PRUNE_SCRIPT} would delete it`)
		}
	}
	for (const file of BUNDLED_WHOLE) {
		for (const name of externalsIn(fs.readFileSync(path.join(root, file), "utf8"))) {
			problems.push(
				`${file} marks ${name} external, but that image ships no node_modules to resolve it from`,
			)
		}
	}
	if (problems.length > 0) {
		for (const problem of problems) process.stdout.write(`${problem}\n`)
		process.exit(1)
	}
}

if (process.argv[1]?.endsWith("check-runtime-deps.mjs")) main()

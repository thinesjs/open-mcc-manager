import fs from "node:fs"
import path from "node:path"

const [, , deployRoot] = process.argv
const nodeModules = path.join(deployRoot, "node_modules")

const runtimeRoots = [
	"@hono/node-server",
	"@hono/trpc-server",
	"@trpc/server",
	"argon2",
	"better-auth",
	"hono",
	"kysely",
	"libsodium-wrappers-sumo",
	"nanoid",
	"pg",
	"pg-boss",
	"ssh2",
	"sshpk",
	"zod",
]

const mustNotShip = ["vitest", "vite", "esbuild", "tsx"]

const packageDir = (name) => path.join(nodeModules, name)

const readManifest = (name) => {
	const manifestPath = path.join(packageDir(name), "package.json")
	if (!fs.existsSync(manifestPath)) return null
	return JSON.parse(fs.readFileSync(manifestPath, "utf8"))
}

const required = new Set()
const queue = [...runtimeRoots]
while (queue.length > 0) {
	const name = queue.shift()
	if (required.has(name)) continue
	required.add(name)
	const manifest = readManifest(name)
	if (!manifest) continue
	const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies }
	for (const dependency of Object.keys(dependencies)) queue.push(dependency)
}

const scopedEntries = (scope) =>
	fs.readdirSync(path.join(nodeModules, scope)).map((name) => `${scope}/${name}`)

const topLevel = fs.readdirSync(nodeModules).filter((entry) => !entry.startsWith("."))
for (const entry of topLevel) {
	const names = entry.startsWith("@") ? scopedEntries(entry) : [entry]
	for (const name of names) {
		if (required.has(name)) continue
		fs.rmSync(packageDir(name), { recursive: true, force: true })
	}
	if (entry.startsWith("@") && fs.readdirSync(path.join(nodeModules, entry)).length === 0) {
		fs.rmdirSync(path.join(nodeModules, entry))
	}
}

for (const name of mustNotShip) {
	if (fs.existsSync(packageDir(name))) {
		console.error(`runtime image must not ship ${name}`)
		process.exit(1)
	}
}

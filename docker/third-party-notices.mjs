import fs from "node:fs"
import path from "node:path"

const LICENCE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-._]|$)/i

const PREAMBLE = `Third-party notices for the open-mcc-manager container images.

Every third-party package whose code this image distributes is recorded below,
whether esbuild folded it into the application bundle or it is deployed under
node_modules. Identical licence texts are printed once, against every package
that carries them.

The base image's own notices are not repeated here. Node.js and the libraries
it bundles are covered by /nodejs/LICENSE, and the Debian packages by the
copyright files under /usr/share/doc with /usr/share/common-licenses.
`

const RULE = "=".repeat(80)

export const packageAt = (file) => {
	const marker = "node_modules/"
	const at = file.lastIndexOf(marker)
	if (at < 0) return null
	const head = file.slice(0, at + marker.length)
	const segments = file.slice(at + marker.length).split("/")
	const [first, second] = segments
	if (first === undefined || first.length === 0) return null
	if (!first.startsWith("@")) return { name: first, dir: `${head}${first}` }
	if (second === undefined || second.length === 0) return null
	return { name: `${first}/${second}`, dir: `${head}${first}/${second}` }
}

const addLocation = (found, name, dir) => {
	const dirs = found.get(name) ?? new Set()
	dirs.add(dir)
	found.set(name, dirs)
}

export const bundledPackages = (metafile) => {
	const found = new Map()
	for (const input of Object.keys(JSON.parse(metafile).inputs ?? {})) {
		const located = packageAt(input)
		if (located) addLocation(found, located.name, located.dir)
	}
	return found
}

const directoryEntries = (dir) => {
	try {
		return fs.readdirSync(dir, { withFileTypes: true })
	} catch {
		return []
	}
}

const packageDirsIn = (nodeModules, found, seen) => {
	for (const entry of directoryEntries(nodeModules)) {
		if (entry.name.startsWith(".")) continue
		if (entry.isSymbolicLink()) continue
		if (!entry.isDirectory()) continue
		if (entry.name.startsWith("@")) {
			for (const scoped of directoryEntries(path.join(nodeModules, entry.name))) {
				if (scoped.name.startsWith(".")) continue
				if (scoped.isSymbolicLink()) continue
				if (!scoped.isDirectory()) continue
				recordPackageDir(
					`${entry.name}/${scoped.name}`,
					path.join(nodeModules, entry.name, scoped.name),
					found,
					seen,
				)
			}
			continue
		}
		recordPackageDir(entry.name, path.join(nodeModules, entry.name), found, seen)
	}
}

const recordPackageDir = (name, dir, found, seen) => {
	const real = fs.realpathSync(dir)
	if (seen.has(real)) return
	seen.add(real)
	addLocation(found, name, dir)
	packageDirsIn(path.join(dir, "node_modules"), found, seen)
}

export const shippedPackages = (nodeModules) => {
	const found = new Map()
	packageDirsIn(nodeModules, found, new Set())
	return found
}

const licenceTextIn = (dir) => {
	if (!fs.existsSync(dir)) return ""
	const files = fs
		.readdirSync(dir)
		.filter((entry) => LICENCE_FILE.test(entry))
		.sort()
	return files
		.map((entry) => fs.readFileSync(path.join(dir, entry), "utf8").trim())
		.filter((text) => text.length > 0)
		.join("\n\n")
}

const declaredLicence = (manifest) => {
	if (typeof manifest.license === "string") return manifest.license
	if (typeof manifest.license === "object" && manifest.license !== null) {
		const type = manifest.license.type
		if (typeof type === "string") return type
	}
	if (Array.isArray(manifest.licenses)) {
		const types = manifest.licenses.flatMap((each) =>
			typeof each?.type === "string" ? [each.type] : [],
		)
		if (types.length > 0) return types.join(" OR ")
	}
	return ""
}

export const readPackage = (name, dir) => {
	const manifestPath = path.join(dir, "package.json")
	const manifest = fs.existsSync(manifestPath)
		? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
		: {}
	return {
		name,
		version: typeof manifest.version === "string" ? manifest.version : "",
		licence: declaredLicence(manifest),
		text: licenceTextIn(dir),
	}
}

export const unattributed = (entries) =>
	entries
		.filter((entry) => entry.text.length === 0 && entry.licence.length === 0)
		.map((entry) => `${entry.name} ${entry.version}`.trim())

export const groupByText = (entries) => {
	const groups = new Map()
	for (const entry of entries) {
		if (entry.text.length === 0) continue
		const existing = groups.get(entry.text)
		if (existing) existing.push(entry)
		else groups.set(entry.text, [entry])
	}
	return [...groups].map(([text, members]) => ({ text, members }))
}

const label = (entry) =>
	[entry.name, entry.version, entry.licence.length > 0 ? `(${entry.licence})` : ""]
		.filter((part) => part.length > 0)
		.join(" ")

export const render = (entries) => {
	const sorted = [...entries].sort(
		(a, b) =>
			a.name.localeCompare(b.name) ||
			a.version.localeCompare(b.version, undefined, { numeric: true }),
	)
	const sections = [PREAMBLE]
	for (const group of groupByText(sorted)) {
		sections.push(`${RULE}\n${group.members.map(label).join("\n")}\n${RULE}\n\n${group.text}\n`)
	}
	const declaredOnly = sorted.filter((entry) => entry.text.length === 0)
	if (declaredOnly.length > 0) {
		sections.push(
			`${RULE}\nPackages that publish no licence file of their own\n${RULE}\n\nTheir manifests declare the licence recorded beside each name, and their\npublished tarballs carry no text to reproduce.\n\n${declaredOnly
				.map((entry) => `${entry.name} ${entry.version} — ${entry.licence}`)
				.join("\n")}\n`,
		)
	}
	return sections.join("\n")
}

export const collectEntries = (installRoot, deployRoot, metafiles) => {
	const locations = []
	for (const metafile of metafiles) {
		for (const [name, dirs] of bundledPackages(fs.readFileSync(metafile, "utf8"))) {
			for (const dir of dirs) locations.push({ name, dir: path.resolve(installRoot, dir) })
		}
	}
	for (const [name, dirs] of shippedPackages(path.join(deployRoot, "node_modules"))) {
		for (const dir of dirs) locations.push({ name, dir })
	}

	const byVersion = new Map()
	for (const { name, dir } of locations) {
		const entry = readPackage(name, dir)
		const key = `${entry.name}@${entry.version}`
		if (!byVersion.has(key)) byVersion.set(key, entry)
	}
	return [...byVersion.values()]
}

const main = () => {
	const [, , installRoot, deployRoot, outFile, ...metafiles] = process.argv
	if (!installRoot || !deployRoot || !outFile) {
		process.stdout.write(
			"usage: third-party-notices.mjs <installRoot> <deployRoot> <outFile> <metafile...>\n",
		)
		process.exit(1)
	}

	const entries = collectEntries(installRoot, deployRoot, metafiles)
	const missing = unattributed(entries)
	if (missing.length > 0) {
		process.stdout.write(`no licence text and no declared licence for: ${missing.join(", ")}\n`)
		process.exit(1)
	}

	fs.mkdirSync(path.dirname(outFile), { recursive: true })
	fs.writeFileSync(outFile, render(entries))
	process.stdout.write(`wrote ${entries.length} third-party notices to ${outFile}\n`)
}

if (process.argv[1]?.endsWith("third-party-notices.mjs")) main()

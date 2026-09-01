import { spawnSync } from "node:child_process"

const defaultRun = (command, args) => spawnSync(command, args, { encoding: "utf8" })

const CHECKS = [
	{ name: "biome", command: "pnpm", args: ["exec", "biome", "check", "."] },
	{ name: "type-policy", command: "node", args: ["scripts/check-type-policy.mjs"] },
]

export const runCheck = (check, run = defaultRun) => {
	const result = run(check.command, check.args)
	if (result.error) return { name: check.name, ok: false, output: String(result.error.message) }
	return {
		name: check.name,
		ok: result.status === 0,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
	}
}

export const runAll = (checks = CHECKS, run = defaultRun) =>
	checks.map((each) => runCheck(each, run))

const main = () => {
	const results = runAll()
	for (const result of results) {
		if (result.output.trim().length > 0) process.stdout.write(result.output)
	}
	const failed = results.filter((each) => !each.ok).map((each) => each.name)
	if (failed.length > 0) {
		process.stdout.write(`\nlint failed: ${failed.join(", ")}\n`)
		process.exit(1)
	}
}

if (process.argv[1]?.endsWith("lint.mjs")) main()

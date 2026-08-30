import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const loaderSource = join(
	dirname(fileURLToPath(import.meta.url)),
	"../packages/config/load-env.mjs",
)

const repositoryLayout = (envFileContents: string | null): string => {
	const root = mkdtempSync(join(tmpdir(), "load-env-"))
	const configDir = join(root, "packages", "config")
	mkdirSync(configDir, { recursive: true })
	copyFileSync(loaderSource, join(configDir, "load-env.mjs"))
	if (envFileContents !== null) writeFileSync(join(root, ".env"), envFileContents)
	return configDir
}

const readVariableAfterLoad = (
	configDir: string,
	variable: string,
	env: NodeJS.ProcessEnv,
): string =>
	execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import "./load-env.mjs"; process.stdout.write(process.env.${variable} ?? "")`,
		],
		{ cwd: configDir, env, encoding: "utf8" },
	)

describe("packages/config/load-env.mjs", () => {
	it("loads a variable from the repository .env into a process that has none", () => {
		const configDir = repositoryLayout("TEST_DATABASE_URL=postgres://from-env-file\n")
		expect(readVariableAfterLoad(configDir, "TEST_DATABASE_URL", { PATH: process.env.PATH })).toBe(
			"postgres://from-env-file",
		)
	})

	it("leaves a variable already present in the environment untouched", () => {
		const configDir = repositoryLayout("TEST_DATABASE_URL=postgres://from-env-file\n")
		expect(
			readVariableAfterLoad(configDir, "TEST_DATABASE_URL", {
				PATH: process.env.PATH,
				TEST_DATABASE_URL: "postgres://from-the-shell",
			}),
		).toBe("postgres://from-the-shell")
	})

	it("is inert when the repository has no .env at all", () => {
		const configDir = repositoryLayout(null)
		expect(readVariableAfterLoad(configDir, "TEST_DATABASE_URL", { PATH: process.env.PATH })).toBe(
			"",
		)
	})
})

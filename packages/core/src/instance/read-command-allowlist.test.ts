import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const REPOSITORY_ROOT = new URL("../../../..", import.meta.url).pathname

const SKIPPED = new Set([
	"node_modules",
	"dist",
	"build",
	"coverage",
	".git",
	".turbo",
	".claude",
	".superpowers",
	".work",
])

const SOURCE_FILE = /\.(?:[cm]?ts|tsx)$/

const MINTS_A_READ_COMMAND = /\basReadCommand\b/

const filesMintingReadCommands = (dir: string, found: string[] = []): string[] => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (SKIPPED.has(entry.name)) continue
		const full = join(dir, entry.name)
		if (entry.isDirectory()) {
			filesMintingReadCommands(full, found)
			continue
		}
		if (
			entry.isFile() &&
			SOURCE_FILE.test(entry.name) &&
			MINTS_A_READ_COMMAND.test(readFileSync(full, "utf8"))
		) {
			found.push(relative(REPOSITORY_ROOT, full))
		}
	}
	return found
}

describe("who may turn text into a command a shared connection will run", () => {
	it("is exactly the reviewed read builders, so a write cannot be minted as a read unnoticed", () => {
		expect(filesMintingReadCommands(REPOSITORY_ROOT).sort()).toEqual([
			"packages/core/src/host/health.ts",
			"packages/core/src/instance/console.ts",
			"packages/core/src/instance/reconcile.ts",
			"packages/core/src/instance/task-signals.ts",
			"packages/core/src/status/instance-observer.ts",
			"packages/core/src/system/host-metrics.ts",
			"packages/transport/src/index.ts",
			"packages/transport/src/read-connections.test.ts",
			"packages/transport/src/read-connections.ts",
			"packages/transport/src/ssh/read-connections.integration.test.ts",
		])
	})
})

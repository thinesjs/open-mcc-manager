import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"

const REPOSITORY_ROOT = new URL("../../../..", import.meta.url).pathname

const consoleCallsByFile = (): Readonly<Record<string, number>> => {
	const output = execFileSync(
		"grep",
		[
			"-rnoE",
			"console\\??\\.(error|warn|info|log|debug|trace|dir|table)|console\\[",
			"apps/server/src",
			"apps/worker/src",
		],
		{ cwd: REPOSITORY_ROOT, encoding: "utf8" },
	)
	const counts: Record<string, number> = {}
	for (const line of output.split("\n").filter((each) => each.length > 0)) {
		const file = line.split(":")[0] ?? ""
		if (file.endsWith(".test.ts")) continue
		counts[file] = (counts[file] ?? 0) + 1
	}
	return counts
}

describe("what the two daemons are still allowed to write straight to the console", () => {
	it("is exactly the operator-facing CLI paths, so a new console reference cannot slip in", () => {
		expect(consoleCallsByFile()).toEqual({
			"apps/server/src/bootstrap-owner-cli.ts": 2,
			"apps/server/src/bootstrap-owner.ts": 2,
			"apps/server/src/generate-sealbox-key-cli.ts": 2,
		})
	})
})

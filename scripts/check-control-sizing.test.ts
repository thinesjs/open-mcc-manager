import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { findViolations } from "./check-control-sizing.mjs"

const label = "file.tsx"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const CHECKER = join(ROOT, "scripts", "check-control-sizing.mjs")

const SPAWN_TIMEOUT_MS = 60_000

const made: string[] = []

afterAll(() => {
	for (const directory of made) rmSync(directory, { recursive: true, force: true })
})

const seeded = (files: Record<string, string>): string => {
	const root = mkdtempSync(join(tmpdir(), "a control-sizing-"))
	made.push(root)
	mkdirSync(join(root, "scripts"), { recursive: true })
	copyFileSync(CHECKER, join(root, "scripts", "check-control-sizing.mjs"))
	for (const [path, source] of Object.entries(files)) {
		const full = join(root, "apps", "web", "src", path)
		mkdirSync(dirname(full), { recursive: true })
		writeFileSync(full, source)
	}
	return root
}

const SIZED =
	'export const Remove = () => (\n\t<button className="flex h-9 items-center">Remove</button>\n)\n'

const run = (script: string): { status: number | null; output: string } => {
	const result = spawnSync("node", [script], { encoding: "utf8" })
	return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

describe("controls that set their own size", () => {
	it("flags a button that hardcodes a height beside one that does not", () => {
		const source = `<button className="flex h-9 items-center sm:h-8">Remove</button>`
		expect(findViolations(source, label)).toHaveLength(1)
	})

	it("flags an anchor styled as a button", () => {
		const source = `<a href="/x" className="inline-flex h-10 px-3">Enroll</a>`
		expect(findViolations(source, label)).toHaveLength(1)
	})

	it("accepts a control that takes its size from the shared variants", () => {
		const source = `<button className={cn(buttonVariants({ size: "sm" }), "relative h-9")}>Go</button>`
		expect(findViolations(source, label)).toEqual([])
	})

	it("leaves decorative elements alone, which are not controls", () => {
		const source = `<span className="grid size-7 place-items-center rounded-full">M</span>`
		expect(findViolations(source, label)).toEqual([])
	})

	it("is not confused by an arrow function inside the opening tag", () => {
		const source = [
			"<button",
			"  onKeyDown={(event) => handle(event)}",
			'  className="flex h-9 items-center"',
			">Hold</button>",
		].join("\n")
		expect(findViolations(source, label)).toHaveLength(1)
	})

	it("reports the line the offending class sits on", () => {
		const source = ["<button", '  className="h-9"', ">x</button>"].join("\n")
		expect(findViolations(source, label)[0]).toContain("file.tsx:2")
	})
})

describe("the command pnpm lint runs", () => {
	it(
		"exits 0 on the tree as it stands",
		() => {
			const { status, output } = run(CHECKER)

			expect(output).toBe("")
			expect(status).toBe(0)
		},
		SPAWN_TIMEOUT_MS,
	)

	it(
		"★ exits 1 naming the file and line of a control that sizes itself, so a gutted body is caught",
		() => {
			const root = seeded({ "components/remove-button.tsx": SIZED })

			const { status, output } = run(join(root, "scripts", "check-control-sizing.mjs"))

			expect(status).toBe(1)
			expect(output).toContain(
				`${join("apps", "web", "src", "components", "remove-button.tsx")}:2 an interactive <button> sets its own size`,
			)
		},
		SPAWN_TIMEOUT_MS,
	)

	it(
		"★ checks nothing when it is imported rather than run, so a violation cannot end the test worker",
		() => {
			const root = seeded({ "components/remove-button.tsx": SIZED })
			const copy = pathToFileURL(join(root, "scripts", "check-control-sizing.mjs")).href

			const result = spawnSync(
				"node",
				["--input-type=module", "--eval", `await import("${copy}")`],
				{
					encoding: "utf8",
				},
			)

			expect(`${result.stdout}${result.stderr}`).toBe("")
			expect(result.status).toBe(0)
		},
		SPAWN_TIMEOUT_MS,
	)
})

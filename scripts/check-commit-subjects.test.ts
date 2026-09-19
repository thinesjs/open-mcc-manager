import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { checkCommits, parseLog, readCommits } from "./check-commit-subjects.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const CHECKER = join(ROOT, "scripts", "check-commit-subjects.mjs")

const made: string[] = []

const scratch = (prefix: string): string => {
	const directory = mkdtempSync(join(tmpdir(), prefix))
	made.push(directory)
	return directory
}

afterAll(() => {
	for (const directory of made) rmSync(directory, { recursive: true, force: true })
})

const FIELD = "\u001f"
const RECORD = "\u001e"

const record = (hash: string, parents: string, subject: string, body: string): string =>
	`${hash}${FIELD}${parents}${FIELD}${subject}${FIELD}${body}${RECORD}\n`

const commit = (subject: string, body = "", parents = ["p1"]) => ({
	hash: "abc1234",
	parents,
	subject,
	body,
})

const gitRepo = (): string => {
	const root = scratch("commits-")
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
	const git = (...args: string[]): void => {
		execFileSync("git", args, { cwd: root, env, stdio: "ignore" })
	}
	git("init", "-q", "-b", "main")
	git("config", "user.name", "policy")
	git("config", "user.email", "policy@example.com")
	git("config", "commit.gpgsign", "false")
	writeFileSync(join(root, "a.txt"), "a\n")
	git("add", "a.txt")
	git("commit", "-q", "--no-verify", "-m", "feat(core): add a thing")
	writeFileSync(join(root, "b.txt"), "b\n")
	git("add", "b.txt")
	git("commit", "-q", "--no-verify", "-m", "Improve stuff", "-m", "with a description")
	return root
}

describe("checkCommits", () => {
	it("accepts a conforming subject with a scope", () => {
		expect(checkCommits([commit("feat(server): add first-owner bootstrap cli")])).toEqual([])
	})

	it("accepts a conforming subject without a scope", () => {
		expect(checkCommits([commit("docs: document generating sealbox keys")])).toEqual([])
	})

	it("accepts a breaking-change marker", () => {
		expect(checkCommits([commit("feat(db)!: drop the legacy column")])).toEqual([])
	})

	it("accepts a dotted scope", () => {
		expect(checkCommits([commit("build(docker.compose): pin the client image")])).toEqual([])
	})

	it("rejects an unknown commit type", () => {
		expect(checkCommits([commit("wip(server): halfway there")])).toEqual([
			{ hash: "abc1234", reason: "type" },
		])
	})

	it("rejects a subject with no type prefix", () => {
		expect(checkCommits([commit("add first-owner bootstrap cli")])).toEqual([
			{ hash: "abc1234", reason: "format" },
		])
	})

	it("rejects a capitalised prose subject", () => {
		expect(checkCommits([commit("Add the bootstrap cli")])).toEqual([
			{ hash: "abc1234", reason: "format" },
		])
	})

	it("rejects a subject with nothing after the colon", () => {
		expect(checkCommits([commit("fix(server): ")])).toEqual([{ hash: "abc1234", reason: "format" }])
	})

	it("rejects a subject with an uppercase type", () => {
		expect(checkCommits([commit("Fix(server): close the socket")])).toEqual([
			{ hash: "abc1234", reason: "format" },
		])
	})

	it("rejects a commit carrying a description", () => {
		expect(
			checkCommits([commit("fix(server): close the socket", "The socket leaked on error.")]),
		).toEqual([{ hash: "abc1234", reason: "body" }])
	})

	it("ignores a description that is only whitespace", () => {
		expect(checkCommits([commit("fix(server): close the socket", "\n  \n")])).toEqual([])
	})

	it("reports both a malformed subject and a description on one commit", () => {
		expect(checkCommits([commit("Close the socket", "It leaked.")])).toEqual([
			{ hash: "abc1234", reason: "format" },
			{ hash: "abc1234", reason: "body" },
		])
	})

	it("skips merge commits, whose generated message this project does not author", () => {
		expect(
			checkCommits([commit("Merge pull request #12 from fork", "* branch:\n  a\n", ["p1", "p2"])]),
		).toEqual([])
	})

	it("checks every commit it is given", () => {
		expect(
			checkCommits([
				commit("feat(core): add a thing"),
				{ hash: "def5678", parents: ["p1"], subject: "broken", body: "" },
			]),
		).toEqual([{ hash: "def5678", reason: "format" }])
	})
})

describe("parseLog", () => {
	it("parses a stream of records into commits", () => {
		const log = `${record("aaa", "bbb", "feat(core): one", "")}${record("bbb", "ccc", "fix(core): two", "")}`
		expect(parseLog(log)).toEqual([
			{ hash: "aaa", parents: ["bbb"], subject: "feat(core): one", body: "" },
			{ hash: "bbb", parents: ["ccc"], subject: "fix(core): two", body: "" },
		])
	})

	it("parses a root commit as having no parents", () => {
		expect(parseLog(record("aaa", "", "feat(core): one", ""))).toEqual([
			{ hash: "aaa", parents: [], subject: "feat(core): one", body: "" },
		])
	})

	it("parses a merge commit as having several parents", () => {
		expect(parseLog(record("aaa", "bbb ccc", "Merge branch", ""))).toEqual([
			{ hash: "aaa", parents: ["bbb", "ccc"], subject: "Merge branch", body: "" },
		])
	})

	it("keeps a multi-line description intact", () => {
		expect(parseLog(record("aaa", "bbb", "fix: one", "first line\nsecond line\n"))).toEqual([
			{ hash: "aaa", parents: ["bbb"], subject: "fix: one", body: "first line\nsecond line\n" },
		])
	})

	it("parses an empty log as no commits", () => {
		expect(parseLog("")).toEqual([])
	})
})

describe("readCommits", () => {
	it("reads real commits from a git repository and checks them", () => {
		const root = gitRepo()
		const commits = readCommits("HEAD", root)
		expect(commits).toHaveLength(2)
		expect(commits.map((entry: { subject: string }) => entry.subject)).toEqual([
			"Improve stuff",
			"feat(core): add a thing",
		])
		expect(checkCommits(commits).map((v: { reason: string }) => v.reason)).toEqual([
			"format",
			"body",
		])
	})
})

const SPAWN_TIMEOUT_MS = 60_000

describe("the command CI runs", () => {
	it(
		"exits 1 and names the commit that carries a description",
		() => {
			const result = spawnSync("node", [CHECKER, "HEAD"], { cwd: gitRepo(), encoding: "utf8" })

			expect(result.status).toBe(1)
			expect(`${result.stdout}${result.stderr}`).toContain(
				"commit has a description; subject lines only",
			)
		},
		SPAWN_TIMEOUT_MS,
	)

	it(
		"still runs from a path holding a space, rather than passing without checking",
		() => {
			const directory = scratch("a gate-")
			const copied = join(directory, "check-commit-subjects.mjs")
			copyFileSync(CHECKER, copied)

			const result = spawnSync("node", [copied, "HEAD"], { cwd: gitRepo(), encoding: "utf8" })

			expect(result.status).toBe(1)
			expect(`${result.stdout}${result.stderr}`).toContain(
				"commit has a description; subject lines only",
			)
		},
		SPAWN_TIMEOUT_MS,
	)

	it(
		"exits 0 from that same path over a conforming range, so it is not simply failing",
		() => {
			const directory = scratch("a gate-")
			const copied = join(directory, "check-commit-subjects.mjs")
			copyFileSync(CHECKER, copied)

			const result = spawnSync("node", [copied, "HEAD~1"], { cwd: gitRepo(), encoding: "utf8" })

			expect(`${result.stdout}${result.stderr}`).toBe("")
			expect(result.status).toBe(0)
		},
		SPAWN_TIMEOUT_MS,
	)
})

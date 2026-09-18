import { execFileSync } from "node:child_process"

const TYPES = new Set([
	"build",
	"chore",
	"ci",
	"docs",
	"feat",
	"fix",
	"perf",
	"refactor",
	"revert",
	"style",
	"test",
])

const SUBJECT = /^([a-z]+)(?:\(([a-z0-9][a-z0-9./-]*)\))?!?: (\S.*)$/

const FIELD = "\u001f"
const RECORD = "\u001e"

export const LOG_FORMAT = `%H${FIELD}%P${FIELD}%s${FIELD}%b${RECORD}`

export const parseLog = (log) =>
	log
		.split(RECORD)
		.map((record) => record.replace(/^\r?\n/, ""))
		.filter((record) => record !== "")
		.map((record) => {
			const parts = record.split(FIELD)
			return {
				hash: parts[0],
				parents: parts[1] === "" ? [] : parts[1].split(" "),
				subject: parts[2],
				body: parts.slice(3).join(FIELD),
			}
		})

export const readCommits = (range, cwd) =>
	parseLog(
		execFileSync("git", ["log", `--format=${LOG_FORMAT}`, range], {
			cwd,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		}),
	)

export const checkCommits = (commits) => {
	const violations = []
	for (const commit of commits) {
		if (commit.parents.length > 1) continue
		const match = SUBJECT.exec(commit.subject)
		if (!match) violations.push({ hash: commit.hash, reason: "format" })
		else if (!TYPES.has(match[1])) violations.push({ hash: commit.hash, reason: "type" })
		if (commit.body.trim() !== "") violations.push({ hash: commit.hash, reason: "body" })
	}
	return violations
}

const describe = (reason) => {
	if (reason === "format") return "subject is not 'type(scope): subject'"
	if (reason === "type") return `commit type is not one of ${[...TYPES].join(", ")}`
	return "commit has a description; subject lines only"
}

const main = () => {
	const range = process.argv[2] ?? "HEAD"
	const found = checkCommits(readCommits(range, process.cwd()))
	for (const violation of found) {
		console.error(`${violation.hash} ${describe(violation.reason)}`)
	}
	process.exit(found.length === 0 ? 0 : 1)
}

if (process.argv[1]?.endsWith("check-commit-subjects.mjs")) main()

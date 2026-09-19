import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import {
	isJournalCursor,
	journalBatch,
	journalRefusedCursor,
} from "../../packages/contracts/src/boundary/journal"
import {
	JOURNAL_LINE_COLUMNS,
	JOURNAL_MAX_LINES,
	journalCommand,
} from "../../packages/core/src/status/instance-observer"
import {
	type As,
	buildImage,
	exec,
	journalOf,
	journalShowing,
	neverShowed,
	ROOT,
	remove,
	SANDBOX_PLATFORM,
	shell,
	startHost,
	succeeded,
} from "./sandbox"

const TARGETS = [
	{ name: "Debian 12", baseImage: "debian:bookworm-20250908" },
	{ name: "Debian 13", baseImage: "debian:trixie-20250908" },
	{ name: "Ubuntu 24.04", baseImage: "ubuntu:noble-20250910" },
] as const

const ACCOUNT = "tester"

const INSTANCE = "cursorprobe"

const UNIT = `open-mcc@${INSTANCE}.service`

const WIDE_MARKER = "widestline"

const WIDE_LINE = `${WIDE_MARKER} ${"w".repeat(JOURNAL_LINE_COLUMNS * 2)}`

const PROBE = [
	'read -r count run < "$HOME/lines"',
	`echo ${JSON.stringify(WIDE_LINE)}`,
	"i=0",
	'while [ "$i" -lt "$count" ]; do echo "probe $run line $i"; i=$((i + 1)); done',
	"",
].join("\n")

const unitFile = (run: string): string =>
	[
		"[Unit]",
		`Description=probe ${run}`,
		"[Service]",
		"Type=oneshot",
		`ExecStart=/bin/sh /home/${ACCOUNT}/probe.sh`,
		"",
	].join("\n")

const hosts = new Map<string, string>()
const accounts = new Map<string, As>()

const probeLine = (run: string, index: number): string => `probe ${run} line ${index}`

const finishedRun = (run: string): RegExp => new RegExp(`Finished .*probe ${run}`)

const JOURNAL_SETTLE_MS = 180_000

const DIAGNOSIS = [
	'echo "result: $(systemctl --user show "$1" -p Result -p ExecMainCode -p ExecMainStatus --value | tr "\\n" " ")"',
	'echo "lines file: $(cat "$HOME/lines")"',
	'echo "unfiltered tail:"',
	"journalctl --user --no-pager --output cat -n 40",
].join("\n")

const whyNothingShowed = async (host: string, as: As): Promise<string> =>
	(await shell(host, as, DIAGNOSIS, UNIT)).stdout

const logged = async (host: string, as: As, lines: number): Promise<string> => {
	const run = randomUUID().slice(0, 8)
	const last = probeLine(run, lines - 1)
	expect(
		await journalOf(host, as, UNIT),
		`${last} is already in the journal, so waiting for it would wait for nothing`,
	).not.toContain(last)
	succeeded(
		await shell(
			host,
			{ ...as, input: unitFile(run) },
			`cat > "$HOME/.config/systemd/user/open-mcc@.service" && systemctl --user daemon-reload`,
		),
		"naming the run in the unit",
	)
	succeeded(
		await shell(
			host,
			{ ...as, input: `${String(lines)} ${run}\n` },
			'cat > "$HOME/lines" && systemctl --user start "$1"',
			UNIT,
		),
		`running ${UNIT}`,
	)
	const shown = await journalShowing(host, as, UNIT, last, undefined, JOURNAL_SETTLE_MS)
	expect(
		shown,
		`${neverShowed(UNIT, last, JOURNAL_SETTLE_MS)}\n${shown}\n${await whyNothingShowed(host, as)}`,
	).toContain(last)
	const finished = finishedRun(run)
	const ended = await journalShowing(host, as, UNIT, finished, undefined, JOURNAL_SETTLE_MS)
	expect(ended, `${neverShowed(UNIT, finished, JOURNAL_SETTLE_MS)}\n${ended}`).toMatch(finished)
	return run
}

const ran = async (host: string, as: As, command: string): Promise<string> => {
	const answer = await shell(host, as, command)
	if (answer.status !== 0) {
		throw new Error(`the manager's own journal command exited ${answer.status}: ${answer.stderr}`)
	}
	return answer.stdout
}

beforeAll(async () => {
	for (const target of TARGETS) {
		const image = await buildImage({
			target: "host",
			baseImage: target.baseImage,
			platform: SANDBOX_PLATFORM,
		})
		const host = await startHost({ ...inject("sandbox"), image })
		hosts.set(target.name, host)
		const uid = succeeded(await exec(host, ROOT, ["id", "-u", ACCOUNT]), "reading the uid").trim()
		const as: As = {
			user: ACCOUNT,
			workdir: `/home/${ACCOUNT}`,
			env: {
				XDG_RUNTIME_DIR: `/run/user/${uid}`,
				DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
			},
		}
		accounts.set(target.name, as)
		succeeded(
			await exec(host, ROOT, ["loginctl", "enable-linger", ACCOUNT]),
			"turning lingering on",
		)
		succeeded(
			await shell(
				host,
				ROOT,
				'for attempt in $(seq 300); do [ "$(systemctl is-active "user@$1.service")" = active ] && [ -S "/run/user/$1/bus" ] && exit 0; sleep 0.1; done; exit 1',
				uid,
			),
			"waiting for the account's systemd",
		)
		succeeded(
			await shell(
				host,
				{ ...as, input: PROBE },
				'mkdir -p "$HOME/.config/systemd/user" && cat > "$HOME/probe.sh"',
			),
			"writing the probe",
		)
	}
}, 1_800_000)

afterAll(async () => {
	await remove(...hosts.values())
})

const SEED = journalCommand(INSTANCE, null)

const MALFORMED = `COLUMNS=${JOURNAL_LINE_COLUMNS} XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u ${UNIT} --utc -o short-iso --no-pager --no-full --show-cursor --cursor "2026-09-06T06:16:10.000Z" -n ${JOURNAL_MAX_LINES + 1}`

const hostOf = (name: string): string => hosts.get(name) ?? ""

const accountOf = (name: string): As => accounts.get(name) ?? ROOT

describe.each(TARGETS.map((target) => ({ ...target })))("$name", ({ name }) => {
	it("reports a position the manager recognises as a cursor", async () => {
		const host = hostOf(name)
		const as = accountOf(name)
		await logged(host, as, 20)

		const batch = journalBatch(await ran(host, as, SEED))

		expect(batch.cursor).toBeDefined()
		expect(isJournalCursor(batch.cursor ?? "")).toBe(true)
	})

	it("cuts a line wider than the read asked for, and still names its position", async () => {
		const host = hostOf(name)
		const as = accountOf(name)
		await logged(host, as, 3)

		const answer = await ran(host, as, SEED)
		const batch = journalBatch(answer)
		const widest = batch.lines.filter((line) => line.includes(WIDE_MARKER))

		expect(widest, answer).not.toEqual([])
		expect(
			widest.filter((line) => [...line].length > JOURNAL_LINE_COLUMNS),
			answer,
		).toEqual([])
		expect(
			widest.filter((line) => line.includes(WIDE_LINE)),
			answer,
		).toEqual([])
		expect(isJournalCursor(batch.cursor ?? "")).toBe(true)
	})

	it("reads back just the line its position names when nothing has happened since", async () => {
		const host = hostOf(name)
		const as = accountOf(name)
		const seeded = journalBatch(await ran(host, as, SEED))
		const resume = seeded.cursor ?? ""

		const batch = journalBatch(await ran(host, as, journalCommand(INSTANCE, resume)))

		expect(batch.lines).toEqual([seeded.lines.at(-1)])
		expect(batch.cursor).toBe(resume)
	})

	it("shows nothing and names no position when its position is ahead of the journal", async () => {
		const host = hostOf(name)
		const as = accountOf(name)
		const seeded = journalBatch(await ran(host, as, SEED))
		const ahead = (seeded.cursor ?? "").replace(/;i=[0-9a-f]+;/, ";i=ffffffff;")

		const answer = await shell(host, as, journalCommand(INSTANCE, ahead))
		const batch = journalBatch(answer.stdout)

		expect(batch.lines).toEqual([])
		expect(batch.cursor).toBeUndefined()
		expect(journalRefusedCursor(answer.stderr)).toBe(false)
	})

	it("resumes at the line the stored cursor names, and shows what followed it", async () => {
		const host = hostOf(name)
		const as = accountOf(name)
		const seeded = journalBatch(await ran(host, as, SEED))
		const resume = seeded.cursor ?? ""
		const run = await logged(host, as, 5)

		const answer = await ran(host, as, journalCommand(INSTANCE, resume))
		const batch = journalBatch(answer)

		expect(batch.lines[0], answer).toBe(seeded.lines.at(-1))
		expect(
			batch.lines.filter((line) => line.endsWith(probeLine(run, 4))),
			answer,
		).toHaveLength(1)
		expect(batch.cursor).not.toBe(resume)
	})

	it("still resumes after the entry its cursor named has been vacuumed away", async () => {
		const host = hostOf(name)
		const as = accountOf(name)
		const seeded = journalBatch(await ran(host, as, SEED))
		const resume = seeded.cursor ?? ""
		succeeded(
			await shell(host, ROOT, "journalctl --rotate && journalctl --vacuum-files=1 >/dev/null"),
			"vacuuming the journal",
		)
		const run = await logged(host, as, 7)

		const answer = await ran(host, as, journalCommand(INSTANCE, resume))
		const batch = journalBatch(answer)

		expect(
			batch.lines.filter((line) => line.endsWith(probeLine(run, 6))),
			answer,
		).toHaveLength(1)
		expect(isJournalCursor(batch.cursor ?? "")).toBe(true)
	})

	it("refuses a position it cannot seek to, in the words the manager reads", async () => {
		const host = hostOf(name)
		const as = accountOf(name)

		const answer = await shell(host, as, MALFORMED)

		expect(answer.status).not.toBe(0)
		expect(journalRefusedCursor(answer.stderr)).toBe(true)
		expect(journalBatch(answer.stdout).lines).toEqual([])
	})

	it("bounds a resumed read forward from the cursor, not back from the newest line", async () => {
		const host = hostOf(name)
		const as = accountOf(name)
		const seeded = journalBatch(await ran(host, as, SEED))
		const resume = seeded.cursor ?? ""
		const run = await logged(host, as, JOURNAL_MAX_LINES + 500)

		const answer = await ran(host, as, journalCommand(INSTANCE, resume))
		const batch = journalBatch(answer)

		expect(batch.lines, `${batch.lines.length} lines`).toHaveLength(JOURNAL_MAX_LINES + 1)
		expect(batch.lines[0]).toBe(seeded.lines.at(-1))
		expect(batch.lines.some((line) => line.endsWith(probeLine(run, 100)))).toBe(true)
		expect(batch.lines.some((line) => line.endsWith(probeLine(run, JOURNAL_MAX_LINES + 400)))).toBe(
			false,
		)
	})
})

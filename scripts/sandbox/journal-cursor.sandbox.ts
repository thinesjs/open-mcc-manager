import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import {
	isJournalCursor,
	journalBatch,
	journalRefusedCursor,
} from "../../packages/contracts/src/boundary/journal"
import { JOURNAL_MAX_LINES, journalCommand } from "../../packages/core/src/status/instance-observer"
import {
	type As,
	buildImage,
	exec,
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

const PROBE = [
	'count=$(cat "$HOME/lines")',
	"i=0",
	'while [ "$i" -lt "$count" ]; do echo "probe line $i"; i=$((i + 1)); done',
	"",
].join("\n")

const UNIT_FILE = [
	"[Unit]",
	"Description=open-mcc-manager instance %i",
	"[Service]",
	"Type=oneshot",
	`ExecStart=/bin/sh /home/${ACCOUNT}/probe.sh`,
	"",
].join("\n")

const hosts = new Map<string, string>()
const accounts = new Map<string, As>()

const logged = async (host: string, as: As, lines: number): Promise<void> => {
	succeeded(
		await shell(
			host,
			{ ...as, input: String(lines) },
			'cat > "$HOME/lines" && systemctl --user start "$1"',
			UNIT,
		),
		`running ${UNIT}`,
	)
	const wanted = `probe line ${lines - 1}`
	const journal = await journalShowing(host, as, UNIT, wanted)
	if (!journal.includes(wanted)) throw new Error(neverShowed(UNIT, wanted))
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
			await shell(host, { ...as, input: PROBE }, 'cat > "$HOME/probe.sh"'),
			"writing the probe",
		)
		succeeded(
			await shell(
				host,
				{ ...as, input: UNIT_FILE },
				'mkdir -p "$HOME/.config/systemd/user" && cat > "$HOME/.config/systemd/user/open-mcc@.service" && systemctl --user daemon-reload',
			),
			"writing the probe unit",
		)
	}
}, 1_800_000)

afterAll(async () => {
	await remove(...hosts.values())
})

const SEED = journalCommand(INSTANCE, null)

const MALFORMED = `XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u ${UNIT} --utc -o short-iso --no-pager --show-cursor --cursor "2026-09-06T06:16:10.000Z" -n ${JOURNAL_MAX_LINES + 1}`

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

	it("resumes at the line the stored cursor names, and shows what followed it", async () => {
		const host = hostOf(name)
		const as = accountOf(name)
		const seeded = journalBatch(await ran(host, as, SEED))
		const resume = seeded.cursor ?? ""
		await logged(host, as, 5)

		const batch = journalBatch(await ran(host, as, journalCommand(INSTANCE, resume)))

		expect(batch.lines[0]).toBe(seeded.lines.at(-1))
		expect(batch.lines.filter((line) => line.endsWith("probe line 4"))).toHaveLength(1)
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
		await logged(host, as, 7)

		const batch = journalBatch(await ran(host, as, journalCommand(INSTANCE, resume)))

		expect(batch.lines.filter((line) => line.endsWith("probe line 6"))).toHaveLength(1)
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
		await logged(host, as, JOURNAL_MAX_LINES + 500)

		const batch = journalBatch(await ran(host, as, journalCommand(INSTANCE, resume)))

		expect(batch.lines).toHaveLength(JOURNAL_MAX_LINES + 1)
		expect(batch.lines[0]).toBe(seeded.lines.at(-1))
		expect(batch.lines.some((line) => line.endsWith("probe line 100"))).toBe(true)
		expect(batch.lines.some((line) => line.endsWith(`probe line ${JOURNAL_MAX_LINES + 400}`))).toBe(
			false,
		)
	})
})

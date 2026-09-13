import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type HostProfile, profileFrom, rootlessProfile, systemProfile } from "../host/profile"
import { processesGoneCommand, removeAccountCommand, removeDirectoryCommand } from "./removal"
import { validateInstanceId } from "./unit"

const ID_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

const ACCEPTED_IDS = [
	...ID_CHARACTERS.split(""),
	ID_CHARACTERS,
	"-rf",
	"--",
	"__",
	"V1StGXR8Z5jdHi6B",
]

const REJECTED_IDS = [
	"",
	".",
	"..",
	"../..",
	"a/..",
	"/",
	"*",
	"a b",
	"a%i",
	"x'y",
	"a\nb",
	"a".repeat(65),
]

const PROFILES: HostProfile[] = [
	systemProfile(),
	rootlessProfile("/home/mcc"),
	profileFrom("system", "/", "/etc/systemd/system"),
	profileFrom("rootless", "/srv/open-mcc/", "/etc/systemd/system"),
]

const RENDERED_REMOVAL = /^rm -rf -- '([^']+)'$/

describe("the directory an instance removal deletes", () => {
	it("is exactly that instance's own directory, for every id the validator accepts", () => {
		for (const profile of PROFILES) {
			for (const id of ACCEPTED_IDS) {
				const target = RENDERED_REMOVAL.exec(removeDirectoryCommand(profile, id))?.[1] ?? ""
				const instances = posix.normalize(`${profile.instancesRoot}/instances`)

				expect(target).toBe(`${profile.instancesRoot}/instances/${validateInstanceId(id)}`)
				expect(posix.basename(target)).toBe(id)
				expect(posix.dirname(posix.normalize(target))).toBe(instances.replace(/\/+$/, ""))
				expect(posix.normalize(target)).not.toBe(instances)
				expect(posix.normalize(target)).not.toBe(posix.normalize(profile.instancesRoot))
				expect(posix.normalize(target)).not.toBe("/")
			}
		}
	})

	it("is never rendered for an id the validator refuses", () => {
		for (const profile of PROFILES) {
			for (const id of REJECTED_IDS) {
				expect(() => validateInstanceId(id)).toThrow()
				expect(() => removeDirectoryCommand(profile, id)).toThrow()
			}
		}
	})
})

describe("the account steps of a removal on a root host", () => {
	const scratch: string[] = []

	afterEach(() => {
		for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
	})

	const runWithShims = (command: string, exits: Record<string, number>) => {
		const dir = mkdtempSync(join(tmpdir(), "open-mcc-removal-"))
		scratch.push(dir)
		for (const name of ["id", "pkill", "pgrep", "sleep", "userdel"]) {
			const shim = join(dir, name)
			writeFileSync(shim, `#!/bin/sh\ntouch '${dir}/${name}.called'\nexit ${exits[name] ?? 0}\n`)
			chmodSync(shim, 0o755)
		}
		const result = spawnSync("/bin/sh", ["-c", command], {
			env: { PATH: `${dir}:/usr/bin:/bin` },
			encoding: "utf8",
		})
		return {
			status: result.status,
			called: (name: string) => existsSync(join(dir, `${name}.called`)),
		}
	}

	it("finds the account's processes gone once nothing of that account is left", () => {
		const run = runWithShims(processesGoneCommand(systemProfile(), "abc123"), { pgrep: 1 })
		expect(run.status).toBe(0)
		expect(run.called("pkill")).toBe(true)
	})

	it("reports the account still in use when its processes do not go away", () => {
		const run = runWithShims(processesGoneCommand(systemProfile(), "abc123"), { pgrep: 0 })
		expect(run.status).toBe(1)
	})

	it("reports the account still in use when it cannot tell, rather than assuming it is clear", () => {
		const run = runWithShims(processesGoneCommand(systemProfile(), "abc123"), { pgrep: 2 })
		expect(run.status).not.toBe(0)
	})

	it("has nothing to stop for an account that no longer exists", () => {
		const run = runWithShims(processesGoneCommand(systemProfile(), "abc123"), { id: 1, pgrep: 0 })
		expect(run.status).toBe(0)
		expect(run.called("pkill")).toBe(false)
	})

	it("reports a failed account deletion as a failure", () => {
		const run = runWithShims(removeAccountCommand("abc123"), { userdel: 10 })
		expect(run.status).not.toBe(0)
		expect(run.called("userdel")).toBe(true)
	})

	it("counts an account that is already gone as deleted", () => {
		const run = runWithShims(removeAccountCommand("abc123"), { id: 1, userdel: 6 })
		expect(run.status).toBe(0)
		expect(run.called("userdel")).toBe(false)
	})
})

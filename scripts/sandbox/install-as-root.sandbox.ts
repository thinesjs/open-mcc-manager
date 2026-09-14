import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import {
	exec,
	mintKey,
	type Ran,
	REPOSITORY,
	ROOT,
	read,
	remove,
	shell,
	snapshot,
	startHost,
	succeeded,
} from "./sandbox"

const CHECKOUT = "/srv/install"
const STAND_IN = "/opt/stand-in-install"

const STAND_IN_DOCKER = `#!/bin/sh
case "$1" in
	compose)
		case " $* " in
			*" config --images "*) echo open-mcc-server ;;
		esac
		;;
	volume) exit 1 ;;
	run)
		case " $* " in
			*" --generate-sealbox-key "*) echo "k1:c3RhbmQtaW4=:c3RhbmQtaW4=" ;;
			*" --seal-self-host-key "*)
				printf 'SELF_HOST_PUBLIC_KEY=%s\\nSELF_HOST_PRIVATE_KEY_SEALED=sealed\\nSELF_HOST_PRIVATE_KEY_ID=k1\\n' \\
					"$(cat ${STAND_IN}/public-key)"
				;;
		esac
		;;
	*) exit 1 ;;
esac
`

const LINGER = "/var/lib/systemd/linger"

let host = ""

const copyIn = async (path: string, source: string): Promise<void> => {
	succeeded(
		await shell(
			host,
			{ ...ROOT, input: readFileSync(join(REPOSITORY, source)) },
			'mkdir -p "$(dirname "$1")" && cat > "$1"',
			path,
		),
		`copying ${source} in`,
	)
}

beforeAll(async () => {
	host = await startHost(inject("sandbox"))
	await copyIn(`${CHECKOUT}/scripts/install.sh`, "scripts/install.sh")
	await copyIn(`${CHECKOUT}/scripts/self-host.sh`, "scripts/self-host.sh")
	const key = await mintKey(host)
	succeeded(
		await shell(
			host,
			{ ...ROOT, input: STAND_IN_DOCKER },
			[
				'mkdir -p "$1" "$2/docker"',
				'cat > "$1/docker"',
				'chmod 755 "$1/docker"',
				'printf "%s\\n" "$3" > "$1/public-key"',
				': > "$2/docker/compose.yml"',
				': > "$2/package.json"',
			].join("\n"),
			STAND_IN,
			CHECKOUT,
			key.publicKey,
		),
		"installing a stand-in docker and the files a checkout is recognised by",
	)
})

afterAll(async () => {
	await remove(host)
})

describe("install.sh, run as root on a machine with systemd, sudo and logind", () => {
	let installed: Ran = { status: null, stdout: "", stderr: "" }
	let lingerBefore = ""

	beforeAll(async () => {
		lingerBefore = await snapshot(host, LINGER)
		installed = await exec(
			host,
			{
				user: "root",
				workdir: CHECKOUT,
				env: { PATH: `${STAND_IN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` },
			},
			["sh", "scripts/install.sh"],
		)
	})

	it("finishes the install", () => {
		expect(installed.status, installed.stderr).toBe(0)
		expect(installed.stdout).toContain("Control plane starting")
	})

	it("leaves lingering alone, because a machine it will not offer needs none", async () => {
		expect(await snapshot(host, LINGER)).toBe(lingerBefore)
		expect(installed.stdout).not.toContain("Letting bots on this machine keep running")
	})

	it("offers nothing, and says why", async () => {
		const offered = (await read(host, `${CHECKOUT}/.env`))
			.split("\n")
			.filter((line) => line.startsWith("SELF_HOST_"))
		expect(offered).toEqual([])
		expect(installed.stdout).toContain("ran as root")
	})
})

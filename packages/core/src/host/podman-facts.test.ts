import { spawnSync } from "node:child_process"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	HOST_FACTS_COMMAND,
	nextSubordinateRange,
	parseHostFacts,
	parsePodmanInfo,
	parsePodmanVersion,
	requiredStackFor,
	STORAGE_CONF,
	STORAGE_STATE_COMMAND,
	storageOverridesCommand,
	storageStepCommand,
} from "./podman-facts"

const made: string[] = []

afterEach(() => {
	for (const each of made.splice(0)) rmSync(each, { force: true, recursive: true })
})

const scratchHome = (): string => {
	const home = mkdtempSync(join(tmpdir(), "podman-facts-"))
	made.push(home)
	return home
}

const runIn = (
	home: string,
	script: string,
	extra: Readonly<Record<string, string>> = {},
	path = process.env.PATH ?? "/usr/bin:/bin",
) => spawnSync("/bin/sh", ["-c", script], { env: { PATH: path, HOME: home, ...extra } })

const outputOf = (ran: ReturnType<typeof runIn>): string => ran.stdout.toString()

const writeFile = (home: string, relative: string, content: string): string => {
	const path = join(home, relative)
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, content)
	return path
}

const fakePodman = (home: string, info: string, status = 0): string => {
	const bin = join(home, "bin")
	mkdirSync(bin)
	writeFileSync(
		join(bin, "podman"),
		`#!/bin/sh\necho "$*" >> "$HOME/podman-calls"\nmkdir -p "$HOME/${GRAPH}/overlay" "$HOME/${GRAPH}/db"\nprintf '%s\\n' '${info}'\nexit ${status}\n`,
	)
	chmodSync(join(bin, "podman"), 0o755)
	return `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`
}

const podmanCalls = (home: string): string =>
	existsSync(join(home, "podman-calls")) ? readFileSync(join(home, "podman-calls"), "utf8") : ""

const CONF = ".config/containers/storage.conf"
const GRAPH = ".local/share/containers/storage"

describe("reading Podman's version without starting its runtime", () => {
	it.each([
		{ output: "podman version 4.3.1", major: 4, minor: 3, patch: 1 },
		{ output: "podman version 5.4.2-dev\n", major: 5, minor: 4, patch: 2 },
		{ output: "  podman version 4.9.3  ", major: 4, minor: 9, patch: 3 },
		{ output: "podman version 6.1.0+ds1", major: 6, minor: 1, patch: 0 },
	])("reads '$output' as $major.$minor.$patch", ({ output, major, minor, patch }) => {
		expect(parsePodmanVersion(output)).toEqual({ major, minor, patch })
	})

	it.each([
		{ output: "" },
		{ output: "podman version 4.3" },
		{ output: "Podman version 4.3.1" },
		{ output: "podman version v4.3.1" },
		{ output: "podman version 4.3.1 on 203.0.113.9" },
		{ output: "\u001b[31mpodman version 4.3.1" },
		{ output: "sh: 1: podman: not found" },
		{ output: "podman version 4.3.1\npodman version 5.0.0" },
	])("reads '$output' as unreadable", ({ output }) => {
		expect(parsePodmanVersion(output)).toBeNull()
	})

	it("is the only Podman command the facts read, and never the version subcommand", () => {
		expect(HOST_FACTS_COMMAND).toContain("podman --version")
		expect(HOST_FACTS_COMMAND).not.toMatch(/podman (version|info|ps|images|image|system|unshare)/)
	})
})

describe("choosing the network stack from Podman's major version", () => {
	it("gives major 4 slirp4netns", () => {
		expect(requiredStackFor(4)).toBe("slirp4netns")
	})

	it.each([{ major: 5 }, { major: 6 }])("gives major $major pasta", ({ major }) => {
		expect(requiredStackFor(major)).toBe("pasta")
	})
})

describe("storage settings that move Podman's files somewhere the manager does not look", () => {
	const systemConf = (home: string, content: string): string =>
		writeFile(home, "etc/containers/storage.conf", content)

	it.each([
		{ variable: "XDG_CONFIG_HOME" },
		{ variable: "XDG_DATA_HOME" },
		{ variable: "CONTAINERS_STORAGE_CONF" },
	])("refuses $variable in the account's environment", ({ variable }) => {
		const home = scratchHome()
		const conf = systemConf(home, "[storage]\n")

		const ran = runIn(home, storageOverridesCommand(conf), { [variable]: join(home, "elsewhere") })

		expect(parseHostFacts(outputOf(ran)).overrides).toEqual([variable])
	})

	it("refuses an uncommented rootless_storage_path in the system storage.conf", () => {
		const home = scratchHome()
		const conf = systemConf(home, '[storage]\n  rootless_storage_path = "/srv/containers"\n')

		const ran = runIn(home, storageOverridesCommand(conf))

		expect(parseHostFacts(outputOf(ran)).overrides).toEqual(["rootless_storage_path"])
	})

	it("does not refuse a commented rootless_storage_path", () => {
		const home = scratchHome()
		const conf = systemConf(home, '[storage]\n# rootless_storage_path = "/srv/containers"\n')

		const ran = runIn(home, storageOverridesCommand(conf))

		expect(parseHostFacts(outputOf(ran)).overrides).toEqual([])
	})

	it("does not refuse a host with no system storage.conf at all", () => {
		const home = scratchHome()

		const ran = runIn(home, storageOverridesCommand(join(home, "absent.conf")))

		expect(parseHostFacts(outputOf(ran)).overrides).toEqual([])
	})

	it("reads the real system file in the facts command", () => {
		expect(HOST_FACTS_COMMAND).toContain(storageOverridesCommand("/etc/containers/storage.conf"))
	})
})

describe("whether an account has ever run Podman", () => {
	const stateOf = (home: string) =>
		parseHostFacts(outputOf(runIn(home, STORAGE_STATE_COMMAND))).storage

	it("calls an account with no storage.conf and no graph root fresh", () => {
		expect(stateOf(scratchHome())).toBe("fresh")
	})

	it("calls an account whose graph root is an empty directory fresh", () => {
		const home = scratchHome()
		mkdirSync(join(home, GRAPH), { recursive: true })

		expect(stateOf(home)).toBe("fresh")
	})

	it("calls an account whose graph root holds anything used", () => {
		const home = scratchHome()
		mkdirSync(join(home, GRAPH, "vfs"), { recursive: true })

		expect(stateOf(home)).toBe("used")
	})

	it("calls an account with its own different storage.conf used", () => {
		const home = scratchHome()
		writeFile(home, CONF, '[storage]\ndriver = "vfs"\n')

		expect(stateOf(home)).toBe("used")
	})

	it("calls a storage.conf byte-equal to the manager's set up, even once Podman has run", () => {
		const home = scratchHome()
		writeFile(home, CONF, STORAGE_CONF)
		mkdirSync(join(home, GRAPH, "overlay"), { recursive: true })

		expect(stateOf(home)).toBe("set-up")
	})

	it("does not call a storage.conf that differs by one trailing byte set up", () => {
		const home = scratchHome()
		writeFile(home, CONF, `${STORAGE_CONF}\n`)

		expect(stateOf(home)).toBe("used")
	})

	it("is exactly the manager's overlay setting", () => {
		expect(STORAGE_CONF).toBe('[storage]\ndriver = "overlay"\n')
	})
})

describe("the storage step", () => {
	it("writes storage.conf on a fresh account through a temporary file, then asks Podman", () => {
		const home = scratchHome()
		const path = fakePodman(home, "true overlay")

		const ran = runIn(home, storageStepCommand(), {}, path)

		expect(ran.status, ran.stderr.toString()).toBe(0)
		expect(outputOf(ran).trim()).toBe("ready")
		expect(readFileSync(join(home, CONF), "utf8")).toBe(STORAGE_CONF)
		expect(readdirSync(join(home, ".config/containers"))).toEqual(["storage.conf"])
		expect(readdirSync(join(home, GRAPH)).sort()).toEqual(["db", "overlay"])
		expect(podmanCalls(home)).toContain("info")
		expect(storageStepCommand()).toContain("mv -f")
	})

	it("proceeds without writing when storage.conf is already byte-equal", () => {
		const home = scratchHome()
		const conf = writeFile(home, CONF, STORAGE_CONF)
		chmodSync(conf, 0o640)
		const before = statSync(conf)
		const path = fakePodman(home, "true overlay")

		const ran = runIn(home, storageStepCommand(), {}, path)

		expect(ran.status, ran.stderr.toString()).toBe(0)
		expect(outputOf(ran).trim()).toBe("ready")
		expect(statSync(conf).ino).toBe(before.ino)
		expect(statSync(conf).mode).toBe(before.mode)
	})

	it("writes nothing on an account that already ran Podman, and refuses when it is not overlay", () => {
		const home = scratchHome()
		mkdirSync(join(home, GRAPH, "vfs"), { recursive: true })
		const path = fakePodman(home, "true vfs")

		const ran = runIn(home, storageStepCommand(), {}, path)

		expect(ran.status).not.toBe(0)
		expect(outputOf(ran).trim()).toBe("used")
		expect(existsSync(join(home, CONF))).toBe(false)
	})

	it("refuses as already used when Podman cannot start on an account that already ran it", () => {
		const home = scratchHome()
		mkdirSync(join(home, GRAPH, "vfs"), { recursive: true })
		const path = fakePodman(home, "", 125)

		const ran = runIn(home, storageStepCommand(), {}, path)

		expect(ran.status).not.toBe(0)
		expect(outputOf(ran).trim()).toBe("used")
		expect(existsSync(join(home, CONF))).toBe(false)
	})

	it("reports no refusal word when Podman cannot start on an account it just set up", () => {
		const home = scratchHome()
		const path = fakePodman(home, "", 125)

		const ran = runIn(home, storageStepCommand(), {}, path)

		expect(ran.status).not.toBe(0)
		expect(outputOf(ran).trim()).toBe("")
	})

	it("proceeds on an account that already ran Podman when it already reports overlay", () => {
		const home = scratchHome()
		mkdirSync(join(home, GRAPH, "overlay"), { recursive: true })
		const path = fakePodman(home, "true overlay")

		const ran = runIn(home, storageStepCommand(), {}, path)

		expect(ran.status, ran.stderr.toString()).toBe(0)
		expect(existsSync(join(home, CONF))).toBe(false)
	})

	it("refuses when Podman does not run rootless", () => {
		const home = scratchHome()
		const path = fakePodman(home, "false overlay")

		const ran = runIn(home, storageStepCommand(), {}, path)

		expect(ran.status).not.toBe(0)
		expect(outputOf(ran).trim()).toBe("root")
	})

	it("refuses a storage override before writing anything or starting Podman", () => {
		const home = scratchHome()
		const path = fakePodman(home, "true overlay")

		const ran = runIn(
			home,
			storageStepCommand(),
			{ CONTAINERS_STORAGE_CONF: join(home, "x.conf") },
			path,
		)

		expect(ran.status).not.toBe(0)
		expect(outputOf(ran).trim()).toBe("refused")
		expect(existsSync(join(home, ".config"))).toBe(false)
		expect(podmanCalls(home)).toBe("")
	})

	it("leaves a fresh account as it found it when Podman fails, so the next run is still its first", () => {
		const home = scratchHome()
		const path = fakePodman(home, "", 125)

		const failed = runIn(home, storageStepCommand(), {}, path)
		const again = runIn(home, storageStepCommand(), {}, path)

		expect(failed.status).not.toBe(0)
		expect(existsSync(join(home, CONF))).toBe(false)
		expect(existsSync(join(home, GRAPH))).toBe(false)
		expect(outputOf(again).trim()).toBe(outputOf(failed).trim())
	})

	it.each([
		{ answer: "true vfs", word: "used" },
		{ answer: "false overlay", word: "root" },
	])("takes back the storage.conf it wrote when Podman answers $answer", ({ answer, word }) => {
		const home = scratchHome()
		const path = fakePodman(home, answer)

		const ran = runIn(home, storageStepCommand(), {}, path)

		expect(outputOf(ran).trim()).toBe(word)
		expect(existsSync(join(home, CONF))).toBe(false)
		expect(existsSync(join(home, GRAPH))).toBe(false)
	})

	it("keeps the graph root of an account that already ran Podman", () => {
		const home = scratchHome()
		const layer = writeFile(home, `${GRAPH}/vfs/layer`, "a layer this account already had")
		const path = fakePodman(home, "true vfs")

		const ran = runIn(home, storageStepCommand(), {}, path)

		expect(outputOf(ran).trim()).toBe("used")
		expect(readFileSync(layer, "utf8")).toBe("a layer this account already had")
	})

	it("keeps the storage.conf it did not write, on an account it had already set up", () => {
		const home = scratchHome()
		writeFile(home, CONF, STORAGE_CONF)
		const layer = writeFile(home, `${GRAPH}/overlay/layer`, "a layer from an earlier run")
		const path = fakePodman(home, "", 125)

		const ran = runIn(home, storageStepCommand(), {}, path)

		expect(ran.status).not.toBe(0)
		expect(readFileSync(join(home, CONF), "utf8")).toBe(STORAGE_CONF)
		expect(readFileSync(layer, "utf8")).toBe("a layer from an earlier run")
	})

	it("empties the graph root it filled without removing a folder that was already there", () => {
		const home = scratchHome()
		mkdirSync(join(home, GRAPH), { recursive: true })
		chmodSync(join(home, GRAPH), 0o700)
		const path = fakePodman(home, "", 125)

		const ran = runIn(home, storageStepCommand(), {}, path)

		expect(ran.status).not.toBe(0)
		expect(readdirSync(join(home, GRAPH))).toEqual([])
		expect(statSync(join(home, GRAPH)).mode & 0o777).toBe(0o700)
	})
})

describe("commands that must parse in dash, the /bin/sh of Debian and Ubuntu", () => {
	it.each([
		{ name: "the host facts", command: HOST_FACTS_COMMAND },
		{ name: "the storage step", command: storageStepCommand() },
	])(
		"never opens a command substitution in $name with a parenthesis, which dash reads as arithmetic",
		({ command }) => {
			expect(command).not.toContain("$((")
		},
	)
})

describe("parsing the host facts", () => {
	const FACTS = [
		"uid=1001",
		"home=/home/mcc",
		"passwd-home=/home/mcc",
		"os=debian 12",
		"podman=podman version 4.3.1",
		"storage=fresh",
		"subuid=own",
		"subuid-end=231072",
		"subgid=own",
		"subgid-end=231072",
		"cgroup=cgroup2fs",
		"helper=slirp4netns",
		"overlay-helper=fuse-overlayfs",
		"metadata=000",
	].join("\n")

	it("reads every fact from one output", () => {
		expect(parseHostFacts(FACTS)).toEqual({
			uid: 1001,
			usableHome: true,
			os: { id: "debian", version: "12" },
			podman: { major: 4, minor: 3, patch: 1 },
			storage: "fresh",
			overrides: [],
			subuid: { own: true, end: 231072 },
			subgid: { own: true, end: 231072 },
			cgroupV2: true,
			helpers: ["slirp4netns"],
			overlayHelper: true,
			metadata: "unanswered",
		})
	})

	it("reads an account with no fuse-overlayfs on it as having none", () => {
		expect(parseHostFacts("overlay-helper=/usr/bin/fuse-overlayfs").overlayHelper).toBe(false)
		expect(parseHostFacts("").overlayHelper).toBe(false)
	})

	it("reads cgroup2fs as cgroup v2 and anything else as not", () => {
		expect(parseHostFacts("cgroup=cgroup2fs").cgroupV2).toBe(true)
		expect(parseHostFacts("cgroup=tmpfs").cgroupV2).toBe(false)
		expect(parseHostFacts("").cgroupV2).toBe(false)
	})

	it.each([
		{ printed: "000", reach: "unanswered" },
		{ printed: "401", reach: "answered" },
		{ printed: "200", reach: "answered" },
		{ printed: "none", reach: "unchecked" },
	])("reads a metadata answer of $printed as $reach", ({ printed, reach }) => {
		expect(parseHostFacts(`metadata=${printed}`).metadata).toBe(reach)
	})

	it("treats a missing or unreadable account state as used, never fresh", () => {
		expect(parseHostFacts("").storage).toBe("used")
		expect(parseHostFacts("storage=pristine").storage).toBe("used")
	})

	it("reads a home that differs from passwd, or has an unsafe shape, as unusable", () => {
		expect(parseHostFacts("home=/home/mcc\npasswd-home=/srv/mcc").usableHome).toBe(false)
		expect(parseHostFacts("home=/home/m c\npasswd-home=/home/m c").usableHome).toBe(false)
	})

	it("keeps no remote text but the few words it expects", () => {
		const facts = parseHostFacts(
			"uid=0 203.0.113.9\nos=\u001b]8;;https://203.0.113.9\u0007 12\nhelper=/usr/bin/pasta\nsubuid=own 1:2 3\nsubuid-end=12 203.0.113.9",
		)

		expect(facts.uid).toBeNull()
		expect(facts.os).toEqual({ id: null, version: "12" })
		expect(facts.helpers).toEqual([])
		expect(facts.subuid).toEqual({ own: false, end: 0 })
	})
})

describe("reading subordinate ids on a host with more ranges than a line cap would keep", () => {
	const OTHER_RANGES = 300

	const subordinateFactsAgainst = (file: string): string =>
		HOST_FACTS_COMMAND.split("\n")
			.filter((line) => line.includes("/etc/subuid") || line.includes("/etc/subgid"))
			.map((line) => line.replaceAll("/etc/subuid", file).replaceAll("/etc/subgid", file))
			.join("\n")

	it("sees the account's own line and the highest end, however far down the files they are", () => {
		const home = scratchHome()
		const others = Array.from(
			{ length: OTHER_RANGES },
			(_, index) => `other${index}:${100000 + index * 65536}:65536`,
		)
		const highestEnd = 100000 + OTHER_RANGES * 65536
		const file = writeFile(
			home,
			"subids",
			[...others, `${userInfo().username}:165536:65536`, ""].join("\n"),
		)
		const script = subordinateFactsAgainst(file)

		const facts = parseHostFacts(outputOf(runIn(home, script)))

		expect(script.split("\n")).toHaveLength(2)
		expect(facts.subuid.own).toBe(true)
		expect(facts.subgid.own).toBe(true)
		expect(nextSubordinateRange(facts.subuid.end, facts.subgid.end)).toEqual({
			start: highestEnd,
			end: highestEnd + 65535,
		})
	})
})

describe("choosing a subordinate id range to add", () => {
	it("starts after the highest end in either file", () => {
		expect(nextSubordinateRange(165536, 231072)).toEqual({ start: 231072, end: 296607 })
	})

	it("starts at 100000 when neither file has a range", () => {
		expect(nextSubordinateRange(0, 0)).toEqual({ start: 100000, end: 165535 })
	})
})

describe("reading what Podman reports about itself", () => {
	it("reads the rootless flag and the storage driver", () => {
		expect(parsePodmanInfo("true overlay\n")).toEqual({ rootless: true, driver: "overlay" })
		expect(parsePodmanInfo("false vfs")).toEqual({ rootless: false, driver: "vfs" })
	})

	it("reads anything else as unknown", () => {
		expect(parsePodmanInfo("")).toEqual({ rootless: null, driver: null })
		expect(parsePodmanInfo("Error: cannot connect")).toEqual({ rootless: null, driver: null })
	})
})

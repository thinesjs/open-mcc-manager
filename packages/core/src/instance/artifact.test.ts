import {
	BOT_CONFIG_PATH_SHAPE,
	isReservedFileName,
	RESERVED_FILE_NAMES,
} from "@open-mcc/contracts/boundary/mcc-config-keys"
import type { InstanceRow } from "@open-mcc/db"
import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import { rootlessProfile } from "../host/profile"
import {
	artifactNamesFor,
	type CollectedArtifact,
	countFrom,
	decodeHostBytes,
	isCollectableName,
	isReplayName,
	MAILER_DATABASE_DEFAULT,
	MAILER_IGNORE_LIST_DEFAULT,
	MAX_ARTIFACT_BYTES,
	mailerStateBytesFrom,
	ORPHANED_CACHE_MINUTES,
	PLAYER_LIST_FILE_DEFAULT,
	REPLAY_KEEP_DAYS,
	REPLAY_SETTLE_MINUTES,
	REPLAYS_PER_SWEEP,
	sweepHostArtifacts,
} from "./artifact"
import { instanceDir } from "./unit"

type FakeScript = NonNullable<Parameters<typeof createFakeTransport>[0]>

const profile = rootlessProfile("/home/mcc")

const DIRECTORY = instanceDir(profile.instancesRoot, "afk")

const instance: InstanceRow = {
	id: "afk",
	organizationId: "org",
	hostId: "host",
	name: "afk",
	minecraftAccount: "a@b.com",
	minecraftUsername: null,
	accountType: "microsoft",
	status: "running",
	lastExitCode: null,
	liveControlPort: 34333,
	liveControlTokenEncrypted: null,
	liveControlTokenKeyId: null,
	authClaimId: null,
	authClaimedAt: null,
	createdAt: new Date(),
}

const MCC_BACKUP_INTERVAL_DEFAULT_MINUTES = 300 / 60

const encoded = (text: string) => Buffer.from(text).toString("base64")

const playerLogRead = `head -c ${MAX_ARTIFACT_BYTES} '${DIRECTORY}/${PLAYER_LIST_FILE_DEFAULT}' 2>/dev/null | base64 | tr -d '\\n'`

const REPLAY_DIR = `${DIRECTORY}/replay_recordings`

const replayList = `find '${REPLAY_DIR}' -maxdepth 1 -type f -name '*.mcpr' -mmin +${REPLAY_SETTLE_MINUTES} 2>/dev/null || true`

const replayPrune = `find '${REPLAY_DIR}' -maxdepth 1 -type f -name '*.mcpr' -mtime +${REPLAY_KEEP_DAYS} -delete -print 2>/dev/null | wc -l`

const cachePrune = `find '${DIRECTORY}/recording_cache' -type f -mmin +${ORPHANED_CACHE_MINUTES} -delete 2>/dev/null; find '${DIRECTORY}/recording_cache' -mindepth 1 -type d -empty -delete -print 2>/dev/null | wc -l`

const replayRead = (name: string) =>
	`head -c ${MAX_ARTIFACT_BYTES + 1} '${DIRECTORY}/replay_recordings/${name}' 2>/dev/null | base64 | tr -d '\\n'`

const sweepWith = async (script: FakeScript, keep?: (kept: CollectedArtifact[]) => void) => {
	const transport = createFakeTransport(script)
	await transport.connect({
		hostname: "h",
		port: 22,
		username: "u",
		privateKey: "k",
		expectedFingerprint: "f",
		timeoutMs: 1,
	})
	const kept: CollectedArtifact[] = []
	const sweeps = await sweepHostArtifacts(
		transport,
		profile,
		[instance],
		new Map(),
		async (_instanceId, artifact) => {
			kept.push(artifact)
		},
	)
	keep?.(kept)
	const sweep = sweeps[0]
	if (sweep === undefined) throw new Error("expected one sweep")
	return { sweep, kept, commands: transport.commands }
}

describe("naming what the client writes", () => {
	it("falls back to the client's own defaults when the saved config names none of them", () => {
		expect(artifactNamesFor(undefined)).toEqual({
			playerList: PLAYER_LIST_FILE_DEFAULT,
			mailerDatabase: MAILER_DATABASE_DEFAULT,
			mailerIgnoreList: MAILER_IGNORE_LIST_DEFAULT,
		})
	})

	it("takes the operator's own file name over the default", () => {
		const document = '[ChatBot.PlayerListLogger]\nFile = "roster.txt"\n'
		expect(artifactNamesFor(document).playerList).toBe("roster.txt")
	})

	it("refuses a name the client expands, because the control plane cannot resolve it", () => {
		const document = '[ChatBot.PlayerListLogger]\nFile = "%username%-players.txt"\n'
		expect(artifactNamesFor(document).playerList).toBeUndefined()
	})

	it("refuses a name that would escape the instance directory", () => {
		expect(isCollectableName("../../etc/passwd")).toBe(false)
		expect(isCollectableName("/etc/passwd")).toBe(false)
		expect(isCollectableName("..")).toBe(false)
		expect(isCollectableName("playerlog.txt")).toBe(true)
	})

	it("★ refuses a name the client or this manager already keeps there, so a drain never truncates it", () => {
		expect(isCollectableName("playerlog.txt.collecting")).toBe(false)
		expect(RESERVED_FILE_NAMES.filter(isCollectableName)).toEqual([])
	})

	it("★ does not take a player list that is really a Mailer file", () => {
		const document = '[ChatBot.Mailer]\nDatabaseFile = "playerlog.txt"\n'

		expect(artifactNamesFor(document).playerList).toBeUndefined()
	})
})

describe("★ the file names the collector takes", () => {
	const names = [
		"playerlog.txt",
		"daily roster.txt",
		"joueurs-été.txt",
		"玩家名单.txt",
		"x".repeat(129),
		"x".repeat(255),
		"x".repeat(256),
		"é".repeat(128),
		"%username%",
		"a/b.txt",
		"..",
		"env",
		"roster.txt.collecting",
		"tab\there",
		"",
	]

	it("takes a name an operator can save, spaces, other scripts and long names included", () => {
		expect(names.filter(isCollectableName)).toEqual([
			"playerlog.txt",
			"daily roster.txt",
			"joueurs-été.txt",
			"玩家名单.txt",
			"x".repeat(129),
			"x".repeat(255),
		])
	})

	it("agrees with every bot file setting on every name, so nothing saved is then refused", () => {
		for (const [key, schema] of Object.entries(BOT_CONFIG_PATH_SHAPE)) {
			expect({ key, collected: names.filter(isCollectableName) }).toEqual({
				key,
				collected: names.filter((name) => schema.safeParse(name).success),
			})
		}
	})
})

describe("reading bytes back off a host", () => {
	it("refuses anything that is not base64, so host text cannot become artifact content", () => {
		expect(decodeHostBytes("bash: base64: command not found", MAX_ARTIFACT_BYTES).kind).toBe(
			"unusable",
		)
		expect(decodeHostBytes("ssh: connect to 10.1.2.3 port 22: refused", 64).kind).toBe("unusable")
	})

	it("reports content over the cap as oversize rather than storing a prefix of it", () => {
		const over = Buffer.alloc(65).toString("base64")
		expect(decodeHostBytes(over, 64).kind).toBe("oversize")
		expect(decodeHostBytes(Buffer.alloc(64).toString("base64"), 64).kind).toBe("content")
	})

	it("treats no output as nothing to collect", () => {
		expect(decodeHostBytes("   \n", MAX_ARTIFACT_BYTES).kind).toBe("empty")
	})

	it("reads a count only when the host answered with one", () => {
		expect(countFrom(" 3\n")).toBe(3)
		expect(countFrom("find: '/x': Permission denied")).toBe(0)
		expect(countFrom("12 files deleted")).toBe(0)
		expect(countFrom("-1")).toBe(0)
	})

	it("reads the two Mailer sizes only as a pair of numbers", () => {
		expect(mailerStateBytesFrom("120 40")).toBe(160)
		expect(mailerStateBytesFrom("120")).toBe(0)
		expect(mailerStateBytesFrom("10.1.2.3 40")).toBe(0)
		expect(mailerStateBytesFrom("0x10 40")).toBe(0)
		expect(mailerStateBytesFrom("120 40 /home/mcc")).toBe(0)
	})

	it("accepts only the file names the client's replay handler produces", () => {
		expect(isReplayName("2026_09_13_10_00_00_000_1_21_4_8123_ab12cd34ef5.mcpr")).toBe(true)
		expect(isReplayName("../MinecraftClient.ini")).toBe(false)
		expect(isReplayName("recording.tmcpr")).toBe(false)
		expect(isReplayName("a b.mcpr")).toBe(false)
	})
})

describe("draining the player list log", () => {
	it("collects what the log holds and removes exactly those bytes from the host", async () => {
		const text = "[2026/9/13 10:0]\nalice, bob\n\n"
		const { sweep, kept, commands } = await sweepWith({
			[playerLogRead]: { stdout: encoded(text), stderr: "", exitCode: 0 },
		})

		expect(sweep.collected).toBe(1)
		expect(kept[0]?.content.toString()).toBe(text)
		expect(commands).toContain(
			`tail -c +${Buffer.byteLength(text) + 1} '${DIRECTORY}/${PLAYER_LIST_FILE_DEFAULT}' > '${DIRECTORY}/player-list.collecting' && mv -f '${DIRECTORY}/player-list.collecting' '${DIRECTORY}/${PLAYER_LIST_FILE_DEFAULT}' || { rm -f '${DIRECTORY}/player-list.collecting'; exit 1; }`,
		)
	})

	it("★ drains through a temporary no bot file can ever be named", async () => {
		const { commands } = await sweepWith({
			[playerLogRead]: { stdout: encoded("alice\n"), stderr: "", exitCode: 0 },
		})
		const drain = commands.find((command) => command.startsWith("tail -c")) ?? ""
		const temporary = / > '([^']+)'/.exec(drain)?.[1] ?? ""

		expect(temporary.startsWith(`${DIRECTORY}/`)).toBe(true)
		expect(isReservedFileName(temporary.slice(DIRECTORY.length + 1))).toBe(true)
	})

	it("★ drains a name as long as the host allows through a temporary that still fits beside it", async () => {
		const name = `${"x".repeat(251)}.txt`
		const read = `head -c ${MAX_ARTIFACT_BYTES} '${DIRECTORY}/${name}' 2>/dev/null | base64 | tr -d '\\n'`
		const transport = createFakeTransport({
			[read]: { stdout: encoded("alice\n"), stderr: "", exitCode: 0 },
		})
		await transport.connect({
			hostname: "h",
			port: 22,
			username: "u",
			privateKey: "k",
			expectedFingerprint: "f",
			timeoutMs: 1,
		})
		const documents = new Map([["afk", `[ChatBot.PlayerListLogger]\nFile = "${name}"\n`]])
		const sweeps = await sweepHostArtifacts(
			transport,
			profile,
			[instance],
			documents,
			async () => undefined,
		)
		const drain = transport.commands.find((command) => command.startsWith("tail -c")) ?? ""
		const temporary = / > '([^']+)'/.exec(drain)?.[1] ?? ""

		expect(sweeps[0]?.collected).toBe(1)
		expect(Buffer.byteLength(temporary.slice(temporary.lastIndexOf("/") + 1))).toBeLessThanOrEqual(
			255,
		)
	})

	it("leaves the host untouched when the control plane could not keep what it read", async () => {
		const text = "[2026/9/13 10:0]\nalice\n\n"
		const transport = createFakeTransport({
			[playerLogRead]: { stdout: encoded(text), stderr: "", exitCode: 0 },
		})
		await transport.connect({
			hostname: "h",
			port: 22,
			username: "u",
			privateKey: "k",
			expectedFingerprint: "f",
			timeoutMs: 1,
		})
		const sweeps = await sweepHostArtifacts(transport, profile, [instance], new Map(), async () => {
			throw new Error("the database refused the write")
		})

		expect(sweeps[0]?.collected).toBe(0)
		expect(sweeps[0]?.failed).toBeGreaterThan(0)
		expect(transport.commands.some((command) => command.startsWith("tail -c"))).toBe(false)
	})

	it("does not count a drain the host refused as collected", async () => {
		const text = "roster\n"
		const drain = `tail -c +${Buffer.byteLength(text) + 1} '${DIRECTORY}/${PLAYER_LIST_FILE_DEFAULT}' > '${DIRECTORY}/player-list.collecting' && mv -f '${DIRECTORY}/player-list.collecting' '${DIRECTORY}/${PLAYER_LIST_FILE_DEFAULT}' || { rm -f '${DIRECTORY}/player-list.collecting'; exit 1; }`
		const { sweep } = await sweepWith({
			[playerLogRead]: { stdout: encoded(text), stderr: "", exitCode: 0 },
			[drain]: { stdout: "", stderr: "", exitCode: 1 },
		})

		expect(sweep.collected).toBe(0)
		expect(sweep.failed).toBe(1)
	})

	it("collects nothing when the saved config points the log somewhere we cannot resolve", async () => {
		const transport = createFakeTransport({})
		await transport.connect({
			hostname: "h",
			port: 22,
			username: "u",
			privateKey: "k",
			expectedFingerprint: "f",
			timeoutMs: 1,
		})
		const documents = new Map([["afk", '[ChatBot.PlayerListLogger]\nFile = "%username%.txt"\n']])
		const sweeps = await sweepHostArtifacts(
			transport,
			profile,
			[instance],
			documents,
			async () => undefined,
		)

		expect(sweeps[0]?.refused).toBeGreaterThan(0)
		expect(transport.commands.some((command) => command.startsWith("find "))).toBe(true)
		expect(transport.commands.some((command) => command.includes("%username%"))).toBe(false)
	})

	it("★ never reads or drains the token file when the saved config names it as the player list", async () => {
		const transport = createFakeTransport({})
		await transport.connect({
			hostname: "h",
			port: 22,
			username: "u",
			privateKey: "k",
			expectedFingerprint: "f",
			timeoutMs: 1,
		})
		const documents = new Map([["afk", '[ChatBot.PlayerListLogger]\nFile = "env"\n']])
		const sweeps = await sweepHostArtifacts(
			transport,
			profile,
			[instance],
			documents,
			async () => undefined,
		)

		expect(sweeps[0]?.refused).toBeGreaterThan(0)
		expect(transport.commands.some((command) => command.includes(`${DIRECTORY}/env`))).toBe(false)
	})
})

describe("collecting finished replays", () => {
	const name = "2026_09_13_10_00_00_000_1_21_4_8123_ab12cd34ef5.mcpr"

	it("takes the archive and deletes it from the host", async () => {
		const { sweep, kept, commands } = await sweepWith({
			[replayList]: { stdout: `${REPLAY_DIR}/${name}\n`, stderr: "", exitCode: 0 },
			[replayRead(name)]: { stdout: encoded("PKreplay"), stderr: "", exitCode: 0 },
		})

		expect(sweep.collected).toBe(1)
		expect(kept[0]?.kind).toBe("replay")
		expect(commands).toContain(`rm -f '${DIRECTORY}/replay_recordings/${name}'`)
	})

	it("leaves an archive too large to carry where it is, and says so", async () => {
		const { sweep, commands } = await sweepWith({
			[replayList]: { stdout: `${REPLAY_DIR}/${name}\n`, stderr: "", exitCode: 0 },
			[replayRead(name)]: {
				stdout: Buffer.alloc(MAX_ARTIFACT_BYTES + 1).toString("base64"),
				stderr: "",
				exitCode: 0,
			},
		})

		expect(sweep.oversize).toBe(1)
		expect(sweep.collected).toBe(0)
		expect(commands).not.toContain(`rm -f '${DIRECTORY}/replay_recordings/${name}'`)
	})

	it("ignores anything in the directory that is not a replay the client named", async () => {
		const { commands } = await sweepWith({
			[replayList]: {
				stdout: `${REPLAY_DIR}/recording.tmcpr\n${REPLAY_DIR}/../MinecraftClient.ini\n${REPLAY_DIR}/notes.txt\n`,
				stderr: "",
				exitCode: 0,
			},
		})

		expect(commands.some((command) => command.includes("MinecraftClient.ini"))).toBe(false)
		expect(commands.some((command) => command.includes("recording.tmcpr"))).toBe(false)
	})

	it("takes no more than one sweep's worth of archives at a time", async () => {
		const names = Array.from(
			{ length: REPLAYS_PER_SWEEP + 4 },
			(_unused, index) => `2026_09_13_10_00_00_00${index}_1_21_4_8123_ab12cd34ef5.mcpr`,
		)
		const { commands } = await sweepWith({
			[replayList]: {
				stdout: `${names.map((each) => `${REPLAY_DIR}/${each}`).join("\n")}\n`,
				stderr: "",
				exitCode: 0,
			},
		})

		expect(commands.filter((command) => command.includes("replay_recordings/2026"))).toHaveLength(
			REPLAYS_PER_SWEEP,
		)
	})

	it("asks only for archives that have stopped changing, because the client writes them in place", async () => {
		const { commands } = await sweepWith({})
		const listing = commands.find((command) => command.includes("-name '*.mcpr'")) ?? ""

		expect(listing).toContain("-mmin +")
		expect(REPLAY_SETTLE_MINUTES).toBeGreaterThanOrEqual(3 * MCC_BACKUP_INTERVAL_DEFAULT_MINUTES)
	})

	it("never follows a path the host handed back, only the name inside the directory it asked about", async () => {
		const { commands } = await sweepWith({
			[replayList]: { stdout: `/etc/${name}\n`, stderr: "", exitCode: 0 },
		})

		expect(commands.some((command) => command.includes(`/etc/${name}`))).toBe(false)
		expect(commands).toContain(replayRead(name))
	})

	it("does not count an archive the host refused to delete as collected", async () => {
		const { sweep } = await sweepWith({
			[replayList]: { stdout: `${REPLAY_DIR}/${name}\n`, stderr: "", exitCode: 0 },
			[replayRead(name)]: { stdout: encoded("PKreplay"), stderr: "", exitCode: 0 },
			[`rm -f '${REPLAY_DIR}/${name}'`]: { stdout: "", stderr: "", exitCode: 1 },
		})

		expect(sweep.collected).toBe(0)
		expect(sweep.failed).toBe(1)
	})
})

describe("counting what was pruned", () => {
	it("counts an archive only once the host has actually deleted it", async () => {
		const { sweep, commands } = await sweepWith({
			[replayPrune]: { stdout: "4\n", stderr: "", exitCode: 0 },
		})
		const prune = commands.find((command) => command.includes("-mtime +")) ?? ""

		expect(sweep.replaysPruned).toBe(4)
		expect(prune.indexOf("-delete")).toBeLessThan(prune.indexOf("-print"))
	})

	it("counts a recording cache only once the host has actually deleted it", async () => {
		const { sweep, commands } = await sweepWith({
			[cachePrune]: { stdout: "2\n", stderr: "", exitCode: 0 },
		})
		const prune = commands.find((command) => command.includes("-type d -empty")) ?? ""

		expect(prune.lastIndexOf("-delete")).toBeLessThan(prune.lastIndexOf("-print"))
		expect(sweep.cacheDirectoriesPruned).toBe(2)
	})
})

describe("what the sweep never fetches", () => {
	it("measures the Mailer files without ever reading them", async () => {
		const measure = `printf '%s %s' "$(wc -c < '${DIRECTORY}/${MAILER_DATABASE_DEFAULT}' 2>/dev/null || printf 0)" "$(wc -c < '${DIRECTORY}/${MAILER_IGNORE_LIST_DEFAULT}' 2>/dev/null || printf 0)"`
		const { sweep, commands } = await sweepWith({
			[measure]: { stdout: "8192 120", stderr: "", exitCode: 0 },
		})

		expect(sweep.mailerStateBytes).toBe(8312)
		expect(
			commands.some(
				(command) => command.includes("base64") && command.includes(MAILER_DATABASE_DEFAULT),
			),
		).toBe(false)
		expect(commands.some((command) => command.includes(`rm -f '${DIRECTORY}/Mailer`))).toBe(false)
		expect(
			commands.some((command) => command.startsWith("tail -c") && command.includes("Mailer")),
		).toBe(false)
	})

	it("prunes an orphaned recording cache but never reads one", async () => {
		const { sweep, commands } = await sweepWith({
			[cachePrune]: { stdout: "2\n", stderr: "", exitCode: 0 },
		})

		expect(sweep.cacheDirectoriesPruned).toBe(2)
		expect(
			commands.some((command) => command.includes("recording_cache") && command.includes("base64")),
		).toBe(false)
	})

	it("keeps counting after a step the host refused, so one bad file cannot stop the sweep", async () => {
		const transport = createFakeTransport(
			{},
			{ exec: { [playerLogRead]: new Error("ssh: connect to host 10.1.2.3 port 22") } },
		)
		await transport.connect({
			hostname: "h",
			port: 22,
			username: "u",
			privateKey: "k",
			expectedFingerprint: "f",
			timeoutMs: 1,
		})
		const sweeps = await sweepHostArtifacts(
			transport,
			profile,
			[instance],
			new Map(),
			async () => undefined,
		)

		expect(sweeps[0]?.failed).toBe(1)
		expect(sweeps[0]?.cacheDirectoriesPruned).toBe(0)
	})
})

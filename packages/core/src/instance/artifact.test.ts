import {
	BOT_CONFIG_PATH_SHAPE,
	RESERVED_FILE_NAMES,
} from "@open-mcc/contracts/boundary/mcc-config-keys"
import type { InstanceRow } from "@open-mcc/db"
import { createFakeTransport, type FakeScript } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import { createPlayerListHost, fingerprintOf, playerListOutput } from "../test/player-list-host"
import {
	type ArtifactStore,
	artifactNamesFor,
	type CollectedArtifact,
	countFrom,
	decodeHostBytes,
	EMPTY_FINGERPRINT,
	fingerprintWindow,
	isCollectableName,
	isReplayName,
	MAILER_DATABASE_DEFAULT,
	MAILER_IGNORE_LIST_DEFAULT,
	MAX_ARTIFACT_BYTES,
	mailerStateBytesFrom,
	PLAYER_LIST_FILE_DEFAULT,
	type PlayerListCursor,
	parsePlayerListRead,
	playerListReadCommand,
	REPLAY_KEEP_DAYS,
	REPLAY_SETTLE_MINUTES,
	REPLAYS_PER_SWEEP,
	sweepHostArtifacts,
	truncateCommand,
} from "./artifact"
import { instanceDir } from "./unit"

const DIRECTORY = instanceDir("afk")

const STATE = `${DIRECTORY}/state`

const REPLAY_DIR = `${DIRECTORY}/replays`

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
	configClaimId: null,
	configClaimedAt: null,
	playerListOffset: "0",
	playerListFingerprint: EMPTY_FINGERPRINT,
	playerListCursorVersion: "0",
	createdAt: new Date(),
}

const START: PlayerListCursor = { offset: 0, fingerprint: EMPTY_FINGERPRINT, version: 0 }

const MCC_BACKUP_INTERVAL_DEFAULT_MINUTES = 300 / 60

const TRUNCATE = "timeout -k 2 10 flock -n "

const encoded = (text: string) => Buffer.from(text).toString("base64")

const rowAt = (cursor: PlayerListCursor): InstanceRow => ({
	...instance,
	playerListOffset: String(cursor.offset),
	playerListFingerprint: cursor.fingerprint,
	playerListCursorVersion: String(cursor.version),
})

const collectedThrough = (text: string, version: number): PlayerListCursor => {
	const content = Buffer.from(text)
	return { offset: content.length, fingerprint: fingerprintOf(content, content.length), version }
}

const replayList = `find ${REPLAY_DIR} -maxdepth 1 -type f -name '*.mcpr' -mmin +${REPLAY_SETTLE_MINUTES} 2>/dev/null || true`

const replayPrune = `find ${REPLAY_DIR} -maxdepth 1 -type f -name '*.mcpr' -mtime +${REPLAY_KEEP_DAYS} -delete -print 2>/dev/null | wc -l`

const replayRead = (name: string) =>
	`dd if=${REPLAY_DIR}/'${name}' iflag=nofollow,nonblock,count_bytes count=${MAX_ARTIFACT_BYTES + 1} bs=65536 status=none | base64 | tr -d '\\n'`

const mailerMeasure = `stat -c '%F %s' -- ${STATE}/'${MAILER_DATABASE_DEFAULT}' ${STATE}/'${MAILER_IGNORE_LIST_DEFAULT}' 2>/dev/null || true`

const memoryStore = (cursor: PlayerListCursor) => {
	const state: { cursor: PlayerListCursor; kept: CollectedArtifact[]; resets: number[] } = {
		cursor,
		kept: [],
		resets: [],
	}
	const store: ArtifactStore = {
		keep: async (_instanceId, artifact) => {
			state.kept.push(artifact)
		},
		storeAndAdvance: async (_instanceId, artifact, advance) => {
			if (advance.version !== state.cursor.version || advance.offset !== state.cursor.offset) {
				throw new Error("the cursor moved")
			}
			state.kept.push(artifact)
			state.cursor = {
				offset: advance.offset + artifact.content.length,
				fingerprint: advance.fingerprint,
				version: advance.version + 1,
			}
		},
		resetCursor: async (_instanceId, version) => {
			state.resets.push(version)
			if (version !== state.cursor.version) return false
			state.cursor = { offset: 0, fingerprint: EMPTY_FINGERPRINT, version: version + 1 }
			return true
		},
	}
	return { state, store }
}

type Transport = ReturnType<typeof createFakeTransport>

const sweepOn = async (
	transport: Transport,
	cursor: PlayerListCursor = START,
	options: {
		documents?: ReadonlyMap<string, string>
		adjust?: (store: ArtifactStore) => ArtifactStore
	} = {},
) => {
	await transport.connect({
		hostname: "h",
		port: 22,
		username: "u",
		privateKey: "k",
		expectedFingerprint: "f",
		timeoutMs: 1,
	})
	const memory = memoryStore(cursor)
	const store = options.adjust?.(memory.store) ?? memory.store
	const sweeps = await sweepHostArtifacts(
		transport,
		[rowAt(cursor)],
		options.documents ?? new Map(),
		store,
		async () => true,
	)
	const sweep = sweeps[0]
	if (sweep === undefined) throw new Error("expected one sweep")
	return { sweep, memory, commands: transport.commands }
}

const hostWith = (
	content: string | Buffer | undefined,
	states: { unit?: string; auth?: string; script?: FakeScript; name?: string } = {},
) =>
	createPlayerListHost(
		"afk",
		states.name ?? PLAYER_LIST_FILE_DEFAULT,
		{
			content: typeof content === "string" ? Buffer.from(content) : content,
			unit: states.unit ?? "active",
			auth: states.auth ?? "inactive",
		},
		states.script,
	)

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

	it("★ refuses a name the client already keeps in its working directory", () => {
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
			"env",
			"roster.txt.collecting",
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

	it("★ counts a Mailer file's size only when it is a regular file", () => {
		expect(mailerStateBytesFrom("regular file 120\nregular file 40\n")).toBe(160)
		expect(mailerStateBytesFrom("regular file 120\nfifo 0\nsymbolic link 40\n")).toBe(120)
		expect(mailerStateBytesFrom("regular empty file 0\n")).toBe(0)
		expect(mailerStateBytesFrom("")).toBe(0)
	})

	it("refuses a Mailer size it cannot read as a file type and a number", () => {
		expect(mailerStateBytesFrom("10.1.2.3 40\n")).toBeUndefined()
		expect(mailerStateBytesFrom("regular file 0x10\n")).toBeUndefined()
		expect(mailerStateBytesFrom("regular file 120 /home/mcc\n")).toBeUndefined()
	})

	it("accepts only the file names the client's replay handler produces", () => {
		expect(isReplayName("2026_09_13_10_00_00_000_1_21_4_8123_ab12cd34ef5.mcpr")).toBe(true)
		expect(isReplayName("../MinecraftClient.ini")).toBe(false)
		expect(isReplayName("recording.tmcpr")).toBe(false)
		expect(isReplayName("a b.mcpr")).toBe(false)
	})
})

describe("★ reading a player list from where its cursor stands", () => {
	it("fingerprints nothing at offset 0, which is the sha256 of no bytes", () => {
		expect(EMPTY_FINGERPRINT).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		)
		expect(fingerprintWindow(0)).toEqual({ skip: 0, count: 0 })
		expect(fingerprintOf(Buffer.from("alice\n"), 0)).toBe(EMPTY_FINGERPRINT)
		expect(playerListReadCommand("afk", "playerlog.txt", 0)).toContain("skip=0 count=0 ")
	})

	it("fingerprints the whole prefix of a file of 1 to 63 bytes, and the last 64 bytes after that", () => {
		for (let size = 1; size <= 63; size += 1) {
			expect(fingerprintWindow(size)).toEqual({ skip: 0, count: size })
			expect(playerListReadCommand("afk", "playerlog.txt", size)).toContain(`skip=0 count=${size} `)
		}
		expect(fingerprintWindow(64)).toEqual({ skip: 0, count: 64 })
		expect(fingerprintWindow(65)).toEqual({ skip: 1, count: 64 })
	})

	it("sizes a regular file only, and reads every byte under state/ with no link followed and no wait on a FIFO", () => {
		const command = playerListReadCommand("afk", "playerlog.txt", 100)
		const reads = command.match(/dd if=\S+ \S+/g) ?? []

		expect(command).toContain(
			`find ${STATE} -maxdepth 1 -type f -name 'playerlog.txt' -printf '%s\\n'`,
		)
		expect(reads).toHaveLength(3)
		for (const read of reads) {
			expect(read).toBe(
				`dd if=${STATE}/'playerlog.txt' iflag=nofollow,nonblock,skip_bytes,count_bytes`,
			)
		}
		expect(command).toContain("show -p ActiveState --value 'open-mcc@afk.service'")
		expect(command).toContain("show -p ActiveState --value 'open-mcc-auth@afk.service'")
		expect(command).not.toContain(`${DIRECTORY}/'`)
		expect(command).not.toContain(" of=")
	})

	it("matches the configured name literally, so a wildcard in it selects no other file", () => {
		expect(playerListReadCommand("afk", "a*b?[c]", 0)).toContain("-name 'a\\*b\\?\\[c\\]'")
	})

	it("reads what the host printed back into a size, both units, both fingerprints and the chunk", () => {
		const read = parsePlayerListRead(
			playerListOutput(Buffer.from("alice\n"), "active", "inactive", 0),
		)

		expect(read).toEqual({
			size: 6,
			unit: "active",
			auth: "inactive",
			before: EMPTY_FINGERPRINT,
			chunk: Buffer.from("alice\n"),
			after: fingerprintOf(Buffer.from("alice\n"), 6),
		})
		expect(parsePlayerListRead(playerListOutput(undefined, "failed", "inactive", 0))?.size).toBe(
			undefined,
		)
	})

	const whole = playerListOutput(Buffer.from("alice\n"), "active", "inactive", 0)
	const lines = whole.split("\n")

	it.each([
		["no output", ""],
		["a missing last line", `${lines.slice(0, 5).join("\n")}\n`],
		["an extra line", `${whole}size=6\n`],
		["no final newline", whole.slice(0, -1)],
		["a short fingerprint", whole.replace(/before=[0-9a-f]{64}/, "before=e3b0")],
		["a chunk that is not base64", whole.replace(/chunk=\S*/, "chunk=!!")],
		["a chunk padded wrongly", whole.replace(/chunk=\S*/, "chunk=YQ")],
		["a size that is not digits", whole.replace("size=6", "size=6e3")],
		["two sizes", whole.replace("size=6", "size=6\n7")],
		["a unit state that is not a state", whole.replace("unit=active", "unit=Active 10.1.2.3")],
	])("★ refuses output with %s rather than guess", (_case, output) => {
		expect(parsePlayerListRead(output)).toBeUndefined()
	})
})

describe("★ collecting a player list without writing to a running bot's files", () => {
	it("stores the next chunk and advances the cursor by the bytes received", async () => {
		const text = "[2026/9/13 10:0]\nalice, bob\n\n"
		const host = hostWith(text)

		const { sweep, memory, commands } = await sweepOn(host.transport)

		expect(sweep.collected).toBe(1)
		expect(memory.state.kept.map((each) => each.content.toString())).toEqual([text])
		expect(memory.state.cursor).toEqual(collectedThrough(text, 1))
		expect(host.truncations()).toBe(0)
		expect(commands.some((command) => / of=|mv |tail -c|rm /.test(command))).toBe(false)
	})

	it("★ counts the bytes it received, never the size the host announced", async () => {
		const host = hostWith(Buffer.alloc(MAX_ARTIFACT_BYTES + 100, 0x61))

		const { memory } = await sweepOn(host.transport)

		expect(memory.state.kept[0]?.content.length).toBe(MAX_ARTIFACT_BYTES)
		expect(memory.state.cursor.offset).toBe(MAX_ARTIFACT_BYTES)
	})

	it("★ stores nothing when the chunk is shorter than the host announced", async () => {
		const short = [
			"size=100",
			"unit=active",
			"auth=inactive",
			`before=${EMPTY_FINGERPRINT}`,
			`chunk=${Buffer.alloc(60).toString("base64")}`,
			`after=${"0".repeat(64)}`,
			"",
		].join("\n")
		const transport = createFakeTransport({
			[playerListReadCommand("afk", PLAYER_LIST_FILE_DEFAULT, 0)]: {
				stdout: short,
				stderr: "",
				exitCode: 0,
			},
		})

		const { sweep, memory } = await sweepOn(transport)

		expect(memory.state.kept).toEqual([])
		expect(memory.state.cursor).toEqual(START)
		expect(sweep.failed).toBe(1)
	})

	it("★ resets when the file is shorter than the offset, and reads it again from the start in the same sweep", async () => {
		const host = hostWith("carol\n")

		const { memory } = await sweepOn(host.transport, {
			offset: 50,
			fingerprint: "a".repeat(64),
			version: 4,
		})

		expect(memory.state.resets).toEqual([4])
		expect(memory.state.kept.map((each) => each.content.toString())).toEqual(["carol\n"])
		expect(memory.state.cursor).toEqual(collectedThrough("carol\n", 6))
	})

	it("★ resets when the bytes before the offset changed, as a truncate and regrow in the same file does", async () => {
		const host = hostWith("bobby\ncarol\n")

		const { memory } = await sweepOn(host.transport, collectedThrough("alice\n", 1))

		expect(memory.state.resets).toEqual([1])
		expect(memory.state.kept.map((each) => each.content.toString())).toEqual(["bobby\ncarol\n"])
		expect(memory.state.cursor).toEqual(collectedThrough("bobby\ncarol\n", 3))
	})

	it("leaves the cursor alone while no regular file has the name", async () => {
		const cursor = collectedThrough("alice\n", 1)

		const { sweep, memory } = await sweepOn(hostWith(undefined).transport, cursor)

		expect(memory.state.resets).toEqual([])
		expect(memory.state.cursor).toEqual(cursor)
		expect(sweep.failed).toBe(0)
	})

	it("★ after a truncate of its own, sets the cursor to offset 0, the empty fingerprint and version + 1", async () => {
		const text = "[2026/9/13 10:0]\nalice\n\n"
		const host = hostWith(text, { unit: "inactive", auth: "inactive" })

		const { memory } = await sweepOn(host.transport, collectedThrough(text, 7))

		expect(host.truncations()).toBe(1)
		expect(host.content?.length).toBe(0)
		expect(memory.state.cursor).toEqual({ offset: 0, fingerprint: EMPTY_FINGERPRINT, version: 8 })
	})

	it("collects the rest and truncates in the same sweep once both units have stopped", async () => {
		const text = "[2026/9/13 10:0]\nalice\n\n"
		const host = hostWith(text, { unit: "failed", auth: "inactive" })

		const { memory } = await sweepOn(host.transport)

		expect(memory.state.kept.map((each) => each.content.toString())).toEqual([text])
		expect(host.truncations()).toBe(1)
		expect(memory.state.cursor).toEqual({ offset: 0, fingerprint: EMPTY_FINGERPRINT, version: 2 })
	})

	it.each([
		["active", "inactive", false],
		["activating", "inactive", false],
		["deactivating", "inactive", false],
		["reloading", "inactive", false],
		["inactive", "active", false],
		["inactive", "activating", false],
		["inactive", "inactive", true],
		["failed", "inactive", true],
		["inactive", "failed", true],
		["failed", "failed", true],
	])("★ with the bot %s and its sign-in %s, truncates: %s", async (unit, auth, truncates) => {
		const text = "alice\n"
		const host = hostWith(text, { unit, auth })

		const { commands } = await sweepOn(host.transport, collectedThrough(text, 1))

		expect(commands.some((command) => command.startsWith(TRUNCATE))).toBe(truncates)
	})

	it("★ never truncates a file larger than the offset, so bytes it has not stored stay on the host", async () => {
		const host = hostWith(Buffer.alloc(MAX_ARTIFACT_BYTES + 10, 0x61), {
			unit: "inactive",
			auth: "inactive",
		})

		const { commands, memory } = await sweepOn(host.transport)

		expect(memory.state.kept).toHaveLength(1)
		expect(commands.some((command) => command.startsWith(TRUNCATE))).toBe(false)
	})

	it("counts a commit refused as stale as a failure, and truncates nothing", async () => {
		const host = hostWith("alice\n", { unit: "inactive", auth: "inactive" })

		const { sweep, commands } = await sweepOn(host.transport, START, {
			adjust: (store) => ({
				...store,
				storeAndAdvance: async () => {
					throw new Error("the cursor moved")
				},
			}),
		})

		expect(sweep.failed).toBe(1)
		expect(sweep.collected).toBe(0)
		expect(commands.some((command) => command.startsWith(TRUNCATE))).toBe(false)
	})

	it("renders its truncate under the lock, within 12 seconds, and only while nothing changed", () => {
		const fingerprint = "f".repeat(64)
		const command = truncateCommand("afk", "playerlog.txt", { offset: 24, fingerprint })
		const checks = [
			"'\\''open-mcc@afk.service'\\''",
			"'\\''open-mcc-auth@afk.service'\\''",
			`-type f -name '\\''playerlog.txt'\\'' -printf '\\''%s\\n'\\'')" = 24 ]`,
			`iflag=nofollow,nonblock,skip_bytes,count_bytes skip=0 count=24 `,
			`= ${fingerprint} ]`,
			"dd if=/dev/null",
		]
		const at = checks.map((check) => command.indexOf(check))

		expect(command.startsWith(`${TRUNCATE}${DIRECTORY}/collect.lock sh -c '`)).toBe(true)
		expect(
			command.endsWith(
				`&& dd if=/dev/null of=${STATE}/'\\''playerlog.txt'\\'' oflag=nofollow,nonblock conv=nocreat status=none'; s=$?; exit $s`,
			),
		).toBe(true)
		expect(command.match(/in inactive\|failed\) ;; \*\) exit 1 ;; esac/g)).toHaveLength(2)
		expect(at.every((position) => position > 0)).toBe(true)
		expect([...at].sort((left, right) => left - right)).toEqual(at)
	})

	it("reads a player list named like a manager file inside state/, never the manager's own file", async () => {
		const host = hostWith("alice\n", { name: "env" })
		const documents = new Map([["afk", '[ChatBot.PlayerListLogger]\nFile = "env"\n']])

		const { sweep, commands } = await sweepOn(host.transport, START, { documents })

		expect(sweep.collected).toBe(1)
		expect(commands.some((command) => command.includes(`${STATE}/'env'`))).toBe(true)
		expect(
			commands.some(
				(command) => command.includes(`${DIRECTORY}/env`) || command.includes(`${DIRECTORY}/'env'`),
			),
		).toBe(false)
	})

	it("collects nothing when the saved config points the log somewhere we cannot resolve", async () => {
		const documents = new Map([["afk", '[ChatBot.PlayerListLogger]\nFile = "%username%.txt"\n']])

		const { sweep, commands } = await sweepOn(createFakeTransport(), START, { documents })

		expect(sweep.refused).toBeGreaterThan(0)
		expect(commands).toContain(replayList)
		expect(commands.some((command) => command.includes("%username%"))).toBe(false)
	})
})

describe("collecting finished replays", () => {
	const name = "2026_09_13_10_00_00_000_1_21_4_8123_ab12cd34ef5.mcpr"

	const sweepReplays = async (script: FakeScript) =>
		await sweepOn(hostWith(undefined, { script }).transport)

	it("takes the archive and deletes it from the host", async () => {
		const { sweep, memory, commands } = await sweepReplays({
			[replayList]: { stdout: `${REPLAY_DIR}/${name}\n`, stderr: "", exitCode: 0 },
			[replayRead(name)]: { stdout: encoded("PKreplay"), stderr: "", exitCode: 0 },
		})

		expect(sweep.collected).toBe(1)
		expect(memory.state.kept[0]?.kind).toBe("replay")
		expect(commands).toContain(`rm -f ${REPLAY_DIR}/'${name}'`)
	})

	it("leaves an archive too large to carry where it is, and says so", async () => {
		const { sweep, commands } = await sweepReplays({
			[replayList]: { stdout: `${REPLAY_DIR}/${name}\n`, stderr: "", exitCode: 0 },
			[replayRead(name)]: {
				stdout: Buffer.alloc(MAX_ARTIFACT_BYTES + 1).toString("base64"),
				stderr: "",
				exitCode: 0,
			},
		})

		expect(sweep.oversize).toBe(1)
		expect(sweep.collected).toBe(0)
		expect(commands).not.toContain(`rm -f ${REPLAY_DIR}/'${name}'`)
	})

	it("ignores anything in the directory that is not a replay the client named", async () => {
		const { commands } = await sweepReplays({
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
		const { commands } = await sweepReplays({
			[replayList]: {
				stdout: `${names.map((each) => `${REPLAY_DIR}/${each}`).join("\n")}\n`,
				stderr: "",
				exitCode: 0,
			},
		})

		expect(commands.filter((command) => command.includes("replays/'2026"))).toHaveLength(
			REPLAYS_PER_SWEEP,
		)
	})

	it("asks only for regular files that have stopped changing, because the client writes them in place", async () => {
		const { commands } = await sweepReplays({})
		const listing = commands.find((command) => command.includes("-name '*.mcpr'")) ?? ""

		expect(listing).toContain("-type f")
		expect(listing).toContain("-mmin +")
		expect(REPLAY_SETTLE_MINUTES).toBeGreaterThanOrEqual(3 * MCC_BACKUP_INTERVAL_DEFAULT_MINUTES)
	})

	it("never follows a path the host handed back, only the name inside the directory it asked about", async () => {
		const { commands } = await sweepReplays({
			[replayList]: { stdout: `/etc/${name}\n`, stderr: "", exitCode: 0 },
		})

		expect(commands.some((command) => command.includes(`/etc/${name}`))).toBe(false)
		expect(commands).toContain(replayRead(name))
	})

	it("does not count an archive the host refused to delete as collected", async () => {
		const { sweep } = await sweepReplays({
			[replayList]: { stdout: `${REPLAY_DIR}/${name}\n`, stderr: "", exitCode: 0 },
			[replayRead(name)]: { stdout: encoded("PKreplay"), stderr: "", exitCode: 0 },
			[`rm -f ${REPLAY_DIR}/'${name}'`]: { stdout: "", stderr: "", exitCode: 1 },
		})

		expect(sweep.collected).toBe(0)
		expect(sweep.failed).toBe(1)
	})
})

describe("counting what was pruned", () => {
	it("counts an archive only once the host has actually deleted it", async () => {
		const { sweep, commands } = await sweepOn(
			hostWith(undefined, { script: { [replayPrune]: { stdout: "4\n", stderr: "", exitCode: 0 } } })
				.transport,
		)
		const prune = commands.find((command) => command.includes("-mtime +")) ?? ""

		expect(sweep.replaysPruned).toBe(4)
		expect(prune.indexOf("-delete")).toBeLessThan(prune.indexOf("-print"))
	})
})

describe("what the sweep never fetches", () => {
	it("measures the Mailer files with stat, which opens neither", async () => {
		const { sweep, commands } = await sweepOn(
			hostWith(undefined, {
				script: {
					[mailerMeasure]: {
						stdout: "regular file 8192\nregular file 120\n",
						stderr: "",
						exitCode: 0,
					},
				},
			}).transport,
		)

		expect(sweep.mailerStateBytes).toBe(8312)
		expect(
			commands.some(
				(command) => command.includes("Mailer") && /base64|dd |rm |tail |wc /.test(command),
			),
		).toBe(false)
	})

	it("★ counts no Mailer bytes for a FIFO or a link planted at its name", async () => {
		const { sweep } = await sweepOn(
			hostWith(undefined, {
				script: {
					[mailerMeasure]: { stdout: "fifo 0\nsymbolic link 12\n", stderr: "", exitCode: 0 },
				},
			}).transport,
		)

		expect(sweep.mailerStateBytes).toBe(0)
	})

	it("★ never touches the recording cache, which the unit empties under the lock before each start", async () => {
		const { commands } = await sweepOn(hostWith("alice\n").transport)

		expect(
			commands.some(
				(command) => command.includes("recording-cache") || command.includes("recording_cache"),
			),
		).toBe(false)
	})

	it("keeps going after a step the host refused, so one bad file cannot stop the sweep", async () => {
		const transport = createFakeTransport(
			{},
			{
				exec: {
					[playerListReadCommand("afk", PLAYER_LIST_FILE_DEFAULT, 0)]: new Error(
						"ssh: connect to host 10.1.2.3 port 22",
					),
				},
			},
		)

		const { sweep, commands } = await sweepOn(transport)

		expect(sweep.failed).toBe(1)
		expect(commands).toContain(replayList)
	})
})

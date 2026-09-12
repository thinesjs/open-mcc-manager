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
	PLAYER_LIST_FILE_DEFAULT,
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

const encoded = (text: string) => Buffer.from(text).toString("base64")

const playerLogRead = `head -c ${MAX_ARTIFACT_BYTES} '${DIRECTORY}/${PLAYER_LIST_FILE_DEFAULT}' 2>/dev/null | base64 | tr -d '\\n'`

const replayList = `ls -1 '${DIRECTORY}/replay_recordings' 2>/dev/null || true`

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
			`tail -c +${Buffer.byteLength(text) + 1} '${DIRECTORY}/${PLAYER_LIST_FILE_DEFAULT}' > '${DIRECTORY}/${PLAYER_LIST_FILE_DEFAULT}.collecting' && mv -f '${DIRECTORY}/${PLAYER_LIST_FILE_DEFAULT}.collecting' '${DIRECTORY}/${PLAYER_LIST_FILE_DEFAULT}' || { rm -f '${DIRECTORY}/${PLAYER_LIST_FILE_DEFAULT}.collecting'; exit 1; }`,
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
		const drain = `tail -c +${Buffer.byteLength(text) + 1} '${DIRECTORY}/${PLAYER_LIST_FILE_DEFAULT}' > '${DIRECTORY}/${PLAYER_LIST_FILE_DEFAULT}.collecting' && mv -f '${DIRECTORY}/${PLAYER_LIST_FILE_DEFAULT}.collecting' '${DIRECTORY}/${PLAYER_LIST_FILE_DEFAULT}' || { rm -f '${DIRECTORY}/${PLAYER_LIST_FILE_DEFAULT}.collecting'; exit 1; }`
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
		expect(transport.commands.some((command) => command.startsWith("ls -1"))).toBe(true)
		expect(transport.commands.some((command) => command.includes("%username%"))).toBe(false)
	})
})

describe("collecting finished replays", () => {
	const name = "2026_09_13_10_00_00_000_1_21_4_8123_ab12cd34ef5.mcpr"

	it("takes the archive and deletes it from the host", async () => {
		const { sweep, kept, commands } = await sweepWith({
			[replayList]: { stdout: `${name}\n`, stderr: "", exitCode: 0 },
			[replayRead(name)]: { stdout: encoded("PKreplay"), stderr: "", exitCode: 0 },
		})

		expect(sweep.collected).toBe(1)
		expect(kept[0]?.kind).toBe("replay")
		expect(commands).toContain(`rm -f '${DIRECTORY}/replay_recordings/${name}'`)
	})

	it("leaves an archive too large to carry where it is, and says so", async () => {
		const { sweep, commands } = await sweepWith({
			[replayList]: { stdout: `${name}\n`, stderr: "", exitCode: 0 },
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
				stdout: "recording.tmcpr\n../MinecraftClient.ini\nnotes.txt\n",
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
			[replayList]: { stdout: `${names.join("\n")}\n`, stderr: "", exitCode: 0 },
		})

		expect(commands.filter((command) => command.includes("replay_recordings/2026"))).toHaveLength(
			REPLAYS_PER_SWEEP,
		)
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
			[`find '${DIRECTORY}/recording_cache' -type f -mmin +1440 -delete 2>/dev/null; find '${DIRECTORY}/recording_cache' -mindepth 1 -type d -empty -print -delete 2>/dev/null | wc -l`]:
				{ stdout: "2\n", stderr: "", exitCode: 0 },
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

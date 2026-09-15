import { createHash } from "node:crypto"
import type { InstanceArtifactKind } from "@open-mcc/contracts"
import type { McConfigValue } from "@open-mcc/contracts/boundary/mcc-config"
import { readMccConfigKeys } from "@open-mcc/contracts/boundary/mcc-config"
import {
	CLIENT_DEFAULT_FILES,
	isOperatorFileName,
} from "@open-mcc/contracts/boundary/mcc-config-keys"
import type { InstanceRow } from "@open-mcc/db"
import type { HostTransport } from "@open-mcc/transport"
import { withDeadline } from "../host/deadline"
import { systemctl } from "../host/profile"
import { authUnitName, INSTANCE_LAYOUT, instanceDir, unitName } from "./unit"

export const ARTIFACT_STEP_TIMEOUT_MS = 20_000

export const MAX_ARTIFACT_BYTES = 512 * 1024

export const REPLAYS_PER_SWEEP = 8

export const REPLAY_KEEP_DAYS = 7

export const REPLAY_SETTLE_MINUTES = 15

export const ARTIFACT_RETENTION_DAYS = 30

export const ARTIFACTS_KEPT_PER_KIND = 48

export const MAILER_STATE_WARN_BYTES = 4 * 1024 * 1024

export const FINGERPRINT_BYTES = 64

export const EMPTY_FINGERPRINT = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

export const TRUNCATE_KILL_AFTER_SECONDS = 2

export const TRUNCATE_DEADLINE_SECONDS = 10

const READ_BLOCK_BYTES = 65536

export const PLAYER_LIST_FILE_DEFAULT = CLIENT_DEFAULT_FILES["ChatBot.PlayerListLogger.File"]

export const MAILER_DATABASE_DEFAULT = CLIENT_DEFAULT_FILES["ChatBot.Mailer.DatabaseFile"]

export const MAILER_IGNORE_LIST_DEFAULT = CLIENT_DEFAULT_FILES["ChatBot.Mailer.IgnoreListFile"]

export const REPLAY_DIRECTORY = "replay_recordings"

export const RECORDING_CACHE_DIRECTORY = "recording_cache"

export const PLAYER_LIST_FILE_KEY = "ChatBot.PlayerListLogger.File"

export const MAILER_DATABASE_KEY = "ChatBot.Mailer.DatabaseFile"

export const MAILER_IGNORE_LIST_KEY = "ChatBot.Mailer.IgnoreListFile"

const COLLECTED_KEYS = [PLAYER_LIST_FILE_KEY, MAILER_DATABASE_KEY, MAILER_IGNORE_LIST_KEY] as const

const STOPPED_UNIT_STATES = ["inactive", "failed"] as const

const BASE64_ONLY = /^[A-Za-z0-9+/]*={0,2}$/

const REPLAY_NAME = /^[A-Za-z0-9_]{1,128}\.mcpr$/

const COUNT_ONLY = /^\d{1,10}$/

const STAT_LINE = /^([a-z]+(?: [a-z]+)*) (0|[1-9][0-9]{0,14})$/

const CURSOR_NUMBER = /^(0|[1-9][0-9]{0,14})$/

const FINGERPRINT = /^[0-9a-f]{64}$/

const PLAYER_LIST_READ =
	/^size=(0|[1-9][0-9]{0,14})?\nunit=([a-z]+(?:-[a-z]+)*)\nauth=([a-z]+(?:-[a-z]+)*)\nbefore=([0-9a-f]{64})\nchunk=([A-Za-z0-9+/]*={0,2})\nafter=([0-9a-f]{64})\n$/

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

const literalPattern = (name: string): string =>
	name.replace(/[*?[\]]/g, (character) => `\\${character}`)

export const isCollectableName = (value: string): boolean => isOperatorFileName(value)

export const isReplayName = (value: string): boolean => REPLAY_NAME.test(value)

export type DecodedContent =
	| { kind: "content"; content: Buffer }
	| { kind: "empty" }
	| { kind: "oversize" }
	| { kind: "unusable" }

export const decodeHostBytes = (encoded: string, limit: number): DecodedContent => {
	const trimmed = encoded.trim()
	if (trimmed.length === 0) return { kind: "empty" }
	if (!BASE64_ONLY.test(trimmed)) return { kind: "unusable" }
	const content = Buffer.from(trimmed, "base64")
	if (content.length === 0) return { kind: "empty" }
	if (content.length > limit) return { kind: "oversize" }
	return { kind: "content", content }
}

export const countFrom = (output: string): number => {
	const trimmed = output.trim()
	if (!COUNT_ONLY.test(trimmed)) return 0
	const value = Number.parseInt(trimmed, 10)
	return Number.isSafeInteger(value) && value > 0 ? value : 0
}

export const mailerStateBytesFrom = (output: string): number | undefined => {
	let bytes = 0
	for (const line of output.split("\n")) {
		if (line === "") continue
		const found = STAT_LINE.exec(line)
		if (found === null) return undefined
		if (found[1] === "regular file") bytes += Number(found[2])
	}
	return bytes
}

export const digestOf = (content: Buffer): string =>
	createHash("sha256").update(content).digest("hex")

export type ArtifactNames = {
	readonly playerList: string | undefined
	readonly mailerDatabase: string | undefined
	readonly mailerIgnoreList: string | undefined
}

const nameFrom = (
	values: ReadonlyMap<string, McConfigValue>,
	key: string,
	fallback: string,
): string | undefined => {
	const value = values.get(key)
	if (value === undefined) return isCollectableName(fallback) ? fallback : undefined
	if (typeof value !== "string") return undefined
	return isCollectableName(value) ? value : undefined
}

export const artifactNamesFor = (document: string | undefined): ArtifactNames => {
	let values: ReadonlyMap<string, McConfigValue> = new Map<string, McConfigValue>()
	if (document !== undefined) {
		try {
			values = readMccConfigKeys(document, COLLECTED_KEYS).values
		} catch {
			return { playerList: undefined, mailerDatabase: undefined, mailerIgnoreList: undefined }
		}
	}
	const playerList = nameFrom(values, PLAYER_LIST_FILE_KEY, PLAYER_LIST_FILE_DEFAULT)
	const mailerDatabase = nameFrom(values, MAILER_DATABASE_KEY, MAILER_DATABASE_DEFAULT)
	const mailerIgnoreList = nameFrom(values, MAILER_IGNORE_LIST_KEY, MAILER_IGNORE_LIST_DEFAULT)
	const isMailerFile = playerList === mailerDatabase || playerList === mailerIgnoreList
	return { playerList: isMailerFile ? undefined : playerList, mailerDatabase, mailerIgnoreList }
}

export type PlayerListCursor = {
	readonly offset: number
	readonly fingerprint: string
	readonly version: number
}

export type CursorAdvance = {
	readonly offset: number
	readonly fingerprint: string
	readonly version: number
}

const cursorOf = (row: InstanceRow): PlayerListCursor | undefined => {
	if (
		!CURSOR_NUMBER.test(row.playerListOffset) ||
		!CURSOR_NUMBER.test(row.playerListCursorVersion) ||
		!FINGERPRINT.test(row.playerListFingerprint)
	) {
		return undefined
	}
	return {
		offset: Number(row.playerListOffset),
		fingerprint: row.playerListFingerprint,
		version: Number(row.playerListCursorVersion),
	}
}

export const fingerprintWindow = (end: number): { skip: number; count: number } => {
	const skip = Math.max(0, end - FINGERPRINT_BYTES)
	return { skip, count: end - skip }
}

const readBytes = (path: string, skip: number | string, count: number | string): string =>
	`dd if=${path} iflag=nofollow,nonblock,skip_bytes,count_bytes skip=${skip} count=${count} bs=${READ_BLOCK_BYTES} status=none`

const activeStateOf = (unit: string): string =>
	systemctl(`show -p ActiveState --value ${shellQuote(unit)}`)

const stateDirectory = (instanceId: string): string =>
	`${instanceDir(instanceId)}/${INSTANCE_LAYOUT.state}`

const regularFileSize = (instanceId: string, name: string): string =>
	`find ${stateDirectory(instanceId)} -maxdepth 1 -type f -name ${shellQuote(literalPattern(name))} -printf '%s\\n'`

export const playerListReadCommand = (instanceId: string, name: string, offset: number): string => {
	const file = `${stateDirectory(instanceId)}/${shellQuote(name)}`
	const before = fingerprintWindow(offset)
	return [
		`s=$(${regularFileSize(instanceId, name)})`,
		"n=0",
		`if [ -n "$s" ] && [ "$s" -ge ${offset} ] 2>/dev/null; then n=$((s - ${offset})); fi`,
		`if [ "$n" -gt ${MAX_ARTIFACT_BYTES} ]; then n=${MAX_ARTIFACT_BYTES}; fi`,
		`e=$((${offset} + n))`,
		"a=0",
		`if [ "$e" -gt ${FINGERPRINT_BYTES} ]; then a=$((e - ${FINGERPRINT_BYTES})); fi`,
		`printf 'size=%s\\nunit=%s\\nauth=%s\\nbefore=%s\\nchunk=' "$s" "$(${activeStateOf(`${unitName(instanceId)}.service`)})" "$(${activeStateOf(authUnitName(instanceId))})" "$(${readBytes(file, before.skip, before.count)} | sha256sum | cut -c1-64)"`,
		`${readBytes(file, offset, "$n")} | base64 | tr -d '\\n'`,
		`printf '\\nafter=%s\\n' "$(${readBytes(file, "$a", "$((e - a))")} | sha256sum | cut -c1-64)"`,
	].join("\n")
}

export type PlayerListRead = {
	readonly size: number | undefined
	readonly unit: string
	readonly auth: string
	readonly before: string
	readonly chunk: Buffer
	readonly after: string
}

export const parsePlayerListRead = (output: string): PlayerListRead | undefined => {
	const found = PLAYER_LIST_READ.exec(output)
	if (found === null) return undefined
	const [, size, unit = "", auth = "", before = "", encoded = "", after = ""] = found
	const chunk = Buffer.from(encoded, "base64")
	if (chunk.toString("base64") !== encoded) return undefined
	return {
		size: size === undefined ? undefined : Number(size),
		unit,
		auth,
		before,
		chunk,
		after,
	}
}

export const truncateCommand = (
	instanceId: string,
	name: string,
	cursor: { readonly offset: number; readonly fingerprint: string },
): string => {
	const directory = instanceDir(instanceId)
	const file = `${stateDirectory(instanceId)}/${shellQuote(name)}`
	const window = fingerprintWindow(cursor.offset)
	const stopped = (unit: string): string =>
		`case "$(${activeStateOf(unit)})" in ${STOPPED_UNIT_STATES.join("|")}) ;; *) exit 1 ;; esac`
	const script = [
		stopped(`${unitName(instanceId)}.service`),
		stopped(authUnitName(instanceId)),
		`[ "$(${regularFileSize(instanceId, name)})" = ${cursor.offset} ]`,
		`[ "$(${readBytes(file, window.skip, window.count)} | sha256sum | cut -c1-64)" = ${cursor.fingerprint} ]`,
		`dd if=/dev/null of=${file} oflag=nofollow,nonblock conv=nocreat status=none`,
	].join(" && ")
	return withDeadline(
		TRUNCATE_KILL_AFTER_SECONDS,
		TRUNCATE_DEADLINE_SECONDS,
		`flock -n ${directory}/${INSTANCE_LAYOUT.collectLock} sh -c ${shellQuote(script)}`,
	)
}

export type CollectedArtifact = {
	readonly kind: InstanceArtifactKind
	readonly content: Buffer
	readonly digest: string
}

export type ArtifactStore = {
	readonly keep: (instanceId: string, artifact: CollectedArtifact) => Promise<void>
	readonly storeAndAdvance: (
		instanceId: string,
		artifact: CollectedArtifact,
		advance: CursorAdvance,
	) => Promise<void>
	readonly resetCursor: (instanceId: string, version: number) => Promise<boolean>
}

export type InstanceArtifactSweep = {
	readonly instanceId: string
	readonly collected: number
	readonly kindsCollected: readonly InstanceArtifactKind[]
	readonly oversize: number
	readonly refused: number
	readonly failed: number
	readonly replaysPruned: number
	readonly mailerStateBytes: number
}

type Tally = {
	collected: number
	kindsCollected: Set<InstanceArtifactKind>
	oversize: number
	refused: number
	failed: number
	replaysPruned: number
	mailerStateBytes: number
}

const emptyTally = (): Tally => ({
	collected: 0,
	kindsCollected: new Set<InstanceArtifactKind>(),
	oversize: 0,
	refused: 0,
	failed: 0,
	replaysPruned: 0,
	mailerStateBytes: 0,
})

const isStopped = (state: string): boolean =>
	STOPPED_UNIT_STATES.some((stopped) => stopped === state)

const exitCodeOf = async (
	transport: HostTransport,
	command: string,
): Promise<number | undefined> => {
	try {
		return (await transport.exec(command, ARTIFACT_STEP_TIMEOUT_MS)).exitCode
	} catch {
		return undefined
	}
}

const readPlayerList = async (
	transport: HostTransport,
	instanceId: string,
	name: string,
	offset: number,
): Promise<PlayerListRead | undefined> => {
	try {
		const result = await transport.exec(
			playerListReadCommand(instanceId, name, offset),
			ARTIFACT_STEP_TIMEOUT_MS,
		)
		return result.exitCode === 0 ? parsePlayerListRead(result.stdout) : undefined
	} catch {
		return undefined
	}
}

const truncatePlayerList = async (
	transport: HostTransport,
	instanceId: string,
	name: string,
	cursor: PlayerListCursor,
	store: ArtifactStore,
	tally: Tally,
): Promise<void> => {
	const exitCode = await exitCodeOf(transport, truncateCommand(instanceId, name, cursor))
	if (exitCode === 1) return
	if (exitCode !== 0) {
		tally.failed += 1
		return
	}
	try {
		await store.resetCursor(instanceId, cursor.version)
	} catch {
		tally.failed += 1
	}
}

const collectPlayerList = async (
	transport: HostTransport,
	instance: InstanceRow,
	name: string,
	store: ArtifactStore,
	tally: Tally,
	stillCollecting: () => Promise<boolean>,
): Promise<void> => {
	const stored = cursorOf(instance)
	if (stored === undefined) {
		tally.refused += 1
		return
	}
	let cursor = stored
	let read = await readPlayerList(transport, instance.id, name, cursor.offset)
	if (
		read?.size !== undefined &&
		(read.size < cursor.offset || read.before !== cursor.fingerprint)
	) {
		let reset = false
		try {
			reset = await store.resetCursor(instance.id, cursor.version)
		} catch {
			reset = false
		}
		if (!reset) {
			tally.failed += 1
			return
		}
		cursor = { offset: 0, fingerprint: EMPTY_FINGERPRINT, version: cursor.version + 1 }
		read = await readPlayerList(transport, instance.id, name, 0)
	}
	if (read === undefined) {
		tally.failed += 1
		return
	}
	if (read.size === undefined) return
	if (read.chunk.length !== Math.min(read.size - cursor.offset, MAX_ARTIFACT_BYTES)) {
		tally.failed += 1
		return
	}
	if (read.chunk.length > 0) {
		const artifact: CollectedArtifact = {
			kind: "playerList",
			content: read.chunk,
			digest: digestOf(read.chunk),
		}
		try {
			await store.storeAndAdvance(instance.id, artifact, {
				offset: cursor.offset,
				fingerprint: read.after,
				version: cursor.version,
			})
		} catch {
			tally.failed += 1
			return
		}
		cursor = {
			offset: cursor.offset + read.chunk.length,
			fingerprint: read.after,
			version: cursor.version + 1,
		}
		tally.collected += 1
		tally.kindsCollected.add("playerList")
	}
	if (cursor.offset === 0 || read.size !== cursor.offset) return
	if (!isStopped(read.unit) || !isStopped(read.auth)) return
	if (!(await stillCollecting())) return
	await truncatePlayerList(transport, instance.id, name, cursor, store, tally)
}

const listSettledReplays = async (
	transport: HostTransport,
	directory: string,
): Promise<readonly string[] | undefined> => {
	try {
		const result = await transport.exec(
			`find ${directory} -maxdepth 1 -type f -name '*.mcpr' -mmin +${REPLAY_SETTLE_MINUTES} 2>/dev/null || true`,
			ARTIFACT_STEP_TIMEOUT_MS,
		)
		return result.stdout
			.split("\n")
			.map((line) => line.trim())
			.map((line) => line.slice(line.lastIndexOf("/") + 1))
			.filter(isReplayName)
			.slice(0, REPLAYS_PER_SWEEP)
	} catch {
		return undefined
	}
}

const readReplay = async (transport: HostTransport, path: string): Promise<string | undefined> => {
	try {
		const result = await transport.exec(
			`dd if=${path} iflag=nofollow,nonblock,count_bytes count=${MAX_ARTIFACT_BYTES + 1} bs=${READ_BLOCK_BYTES} status=none | base64 | tr -d '\\n'`,
			ARTIFACT_STEP_TIMEOUT_MS,
		)
		return result.stdout
	} catch {
		return undefined
	}
}

const collectReplays = async (
	transport: HostTransport,
	directory: string,
	instanceId: string,
	store: ArtifactStore,
	tally: Tally,
): Promise<void> => {
	const names = await listSettledReplays(transport, directory)
	if (names === undefined) {
		tally.failed += 1
		return
	}
	for (const name of names) {
		const path = `${directory}/${shellQuote(name)}`
		const encoded = await readReplay(transport, path)
		if (encoded === undefined) {
			tally.failed += 1
			continue
		}
		const decoded = decodeHostBytes(encoded, MAX_ARTIFACT_BYTES)
		if (decoded.kind === "empty") continue
		if (decoded.kind === "oversize") {
			tally.oversize += 1
			continue
		}
		if (decoded.kind === "unusable") {
			tally.refused += 1
			continue
		}
		const artifact: CollectedArtifact = {
			kind: "replay",
			content: decoded.content,
			digest: digestOf(decoded.content),
		}
		try {
			await store.keep(instanceId, artifact)
		} catch {
			tally.failed += 1
			continue
		}
		if ((await exitCodeOf(transport, `rm -f ${path}`)) !== 0) {
			tally.failed += 1
			continue
		}
		tally.collected += 1
		tally.kindsCollected.add("replay")
	}
}

const pruneReplays = async (
	transport: HostTransport,
	directory: string,
	tally: Tally,
): Promise<void> => {
	try {
		const result = await transport.exec(
			`find ${directory} -maxdepth 1 -type f -name '*.mcpr' -mtime +${REPLAY_KEEP_DAYS} -delete -print 2>/dev/null | wc -l`,
			ARTIFACT_STEP_TIMEOUT_MS,
		)
		tally.replaysPruned += countFrom(result.stdout)
	} catch {
		tally.failed += 1
	}
}

const measureMailerState = async (
	transport: HostTransport,
	instanceId: string,
	names: ArtifactNames,
	tally: Tally,
): Promise<void> => {
	if (names.mailerDatabase === undefined || names.mailerIgnoreList === undefined) {
		tally.refused += 1
		return
	}
	const state = stateDirectory(instanceId)
	try {
		const result = await transport.exec(
			`stat -c '%F %s' -- ${state}/${shellQuote(names.mailerDatabase)} ${state}/${shellQuote(names.mailerIgnoreList)} 2>/dev/null || true`,
			ARTIFACT_STEP_TIMEOUT_MS,
		)
		const bytes = mailerStateBytesFrom(result.stdout)
		if (bytes === undefined) tally.refused += 1
		else tally.mailerStateBytes += bytes
	} catch {
		tally.failed += 1
	}
}

export const sweepHostArtifacts = async (
	transport: HostTransport,
	instances: readonly InstanceRow[],
	documents: ReadonlyMap<string, string>,
	store: ArtifactStore,
	stillCollecting: () => Promise<boolean>,
): Promise<readonly InstanceArtifactSweep[]> => {
	const sweeps: InstanceArtifactSweep[] = []
	for (const instance of instances) {
		if (!(await stillCollecting())) break
		const replays = `${instanceDir(instance.id)}/${INSTANCE_LAYOUT.replays}`
		const names = artifactNamesFor(documents.get(instance.id))
		const tally = emptyTally()

		if (names.playerList === undefined) tally.refused += 1
		else
			await collectPlayerList(transport, instance, names.playerList, store, tally, stillCollecting)

		if (await stillCollecting()) {
			await collectReplays(transport, replays, instance.id, store, tally)
			await pruneReplays(transport, replays, tally)
			await measureMailerState(transport, instance.id, names, tally)
		}

		sweeps.push({
			instanceId: instance.id,
			collected: tally.collected,
			kindsCollected: [...tally.kindsCollected],
			oversize: tally.oversize,
			refused: tally.refused,
			failed: tally.failed,
			replaysPruned: tally.replaysPruned,
			mailerStateBytes: tally.mailerStateBytes,
		})
	}
	return sweeps
}

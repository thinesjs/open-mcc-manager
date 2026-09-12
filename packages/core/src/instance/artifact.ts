import { createHash } from "node:crypto"
import type { InstanceArtifactKind } from "@open-mcc/contracts"
import type { McConfigValue } from "@open-mcc/contracts/boundary/mcc-config"
import { readMccConfigKeys } from "@open-mcc/contracts/boundary/mcc-config"
import type { InstanceRow } from "@open-mcc/db"
import type { HostTransport } from "@open-mcc/transport"
import type { HostProfile } from "../host/profile"
import { instanceDir } from "./unit"

export const ARTIFACT_STEP_TIMEOUT_MS = 20_000

export const MAX_ARTIFACT_BYTES = 512 * 1024

export const REPLAYS_PER_SWEEP = 8

export const REPLAY_KEEP_DAYS = 7

export const ORPHANED_CACHE_MINUTES = 24 * 60

export const ARTIFACT_RETENTION_DAYS = 30

export const ARTIFACTS_KEPT_PER_KIND = 48

export const MAILER_STATE_WARN_BYTES = 4 * 1024 * 1024

export const PLAYER_LIST_FILE_DEFAULT = "playerlog.txt"

export const MAILER_DATABASE_DEFAULT = "MailerDatabase.ini"

export const MAILER_IGNORE_LIST_DEFAULT = "MailerIgnoreList.ini"

export const REPLAY_DIRECTORY = "replay_recordings"

export const RECORDING_CACHE_DIRECTORY = "recording_cache"

export const PLAYER_LIST_FILE_KEY = "ChatBot.PlayerListLogger.File"

export const MAILER_DATABASE_KEY = "ChatBot.Mailer.DatabaseFile"

export const MAILER_IGNORE_LIST_KEY = "ChatBot.Mailer.IgnoreListFile"

const COLLECTED_KEYS = [PLAYER_LIST_FILE_KEY, MAILER_DATABASE_KEY, MAILER_IGNORE_LIST_KEY] as const

const DRAIN_SUFFIX = ".collecting"

const BASE64_ONLY = /^[A-Za-z0-9+/]*={0,2}$/

const COLLECTABLE_NAME = /^[A-Za-z0-9._-]{1,128}$/

const REPLAY_NAME = /^[A-Za-z0-9_]{1,128}\.mcpr$/

const COUNT_ONLY = /^\d{1,10}$/

const TWO_SIZES = /^\s*(\d{1,12})\s+(\d{1,12})\s*$/

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

export const isCollectableName = (value: string): boolean =>
	value !== "." && value !== ".." && COLLECTABLE_NAME.test(value)

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

export const mailerStateBytesFrom = (output: string): number => {
	const found = TWO_SIZES.exec(output)
	if (found === null) return 0
	const database = Number(found[1] ?? "")
	const ignoreList = Number(found[2] ?? "")
	if (!Number.isSafeInteger(database) || !Number.isSafeInteger(ignoreList)) return 0
	return database + ignoreList
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
	return {
		playerList: nameFrom(values, PLAYER_LIST_FILE_KEY, PLAYER_LIST_FILE_DEFAULT),
		mailerDatabase: nameFrom(values, MAILER_DATABASE_KEY, MAILER_DATABASE_DEFAULT),
		mailerIgnoreList: nameFrom(values, MAILER_IGNORE_LIST_KEY, MAILER_IGNORE_LIST_DEFAULT),
	}
}

export type CollectedArtifact = {
	readonly kind: InstanceArtifactKind
	readonly content: Buffer
	readonly digest: string
}

export type InstanceArtifactSweep = {
	readonly instanceId: string
	readonly collected: number
	readonly kindsCollected: readonly InstanceArtifactKind[]
	readonly oversize: number
	readonly refused: number
	readonly failed: number
	readonly replaysPruned: number
	readonly cacheDirectoriesPruned: number
	readonly mailerStateBytes: number
}

export type KeepArtifact = (instanceId: string, artifact: CollectedArtifact) => Promise<void>

type Tally = {
	collected: number
	kindsCollected: Set<InstanceArtifactKind>
	oversize: number
	refused: number
	failed: number
	replaysPruned: number
	cacheDirectoriesPruned: number
	mailerStateBytes: number
}

const emptyTally = (): Tally => ({
	collected: 0,
	kindsCollected: new Set<InstanceArtifactKind>(),
	oversize: 0,
	refused: 0,
	failed: 0,
	replaysPruned: 0,
	cacheDirectoriesPruned: 0,
	mailerStateBytes: 0,
})

const readBase64 = async (
	transport: HostTransport,
	path: string,
	upTo: number,
): Promise<string | undefined> => {
	try {
		const result = await transport.exec(
			`head -c ${upTo} ${shellQuote(path)} 2>/dev/null | base64 | tr -d '\\n'`,
			ARTIFACT_STEP_TIMEOUT_MS,
		)
		return result.stdout
	} catch {
		return undefined
	}
}

const drainHead = async (
	transport: HostTransport,
	path: string,
	bytes: number,
): Promise<boolean> => {
	const part = shellQuote(`${path}${DRAIN_SUFFIX}`)
	const target = shellQuote(path)
	try {
		const result = await transport.exec(
			`tail -c +${bytes + 1} ${target} > ${part} && mv -f ${part} ${target} || { rm -f ${part}; exit 1; }`,
			ARTIFACT_STEP_TIMEOUT_MS,
		)
		return result.exitCode === 0
	} catch {
		return false
	}
}

const removeFile = async (transport: HostTransport, path: string): Promise<boolean> => {
	try {
		const result = await transport.exec(`rm -f ${shellQuote(path)}`, ARTIFACT_STEP_TIMEOUT_MS)
		return result.exitCode === 0
	} catch {
		return false
	}
}

const collectPlayerList = async (
	transport: HostTransport,
	directory: string,
	name: string,
	instanceId: string,
	keep: KeepArtifact,
	tally: Tally,
): Promise<void> => {
	const path = `${directory}/${name}`
	const encoded = await readBase64(transport, path, MAX_ARTIFACT_BYTES)
	if (encoded === undefined) {
		tally.failed += 1
		return
	}
	const decoded = decodeHostBytes(encoded, MAX_ARTIFACT_BYTES)
	if (decoded.kind === "empty") return
	if (decoded.kind === "unusable" || decoded.kind === "oversize") {
		tally.refused += 1
		return
	}
	const artifact: CollectedArtifact = {
		kind: "playerList",
		content: decoded.content,
		digest: digestOf(decoded.content),
	}
	try {
		await keep(instanceId, artifact)
	} catch {
		tally.failed += 1
		return
	}
	if (!(await drainHead(transport, path, decoded.content.length))) {
		tally.failed += 1
		return
	}
	tally.collected += 1
	tally.kindsCollected.add("playerList")
}

const listReplayNames = async (
	transport: HostTransport,
	directory: string,
): Promise<readonly string[] | undefined> => {
	try {
		const result = await transport.exec(
			`ls -1 ${shellQuote(directory)} 2>/dev/null || true`,
			ARTIFACT_STEP_TIMEOUT_MS,
		)
		return result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(isReplayName)
			.slice(0, REPLAYS_PER_SWEEP)
	} catch {
		return undefined
	}
}

const collectReplays = async (
	transport: HostTransport,
	directory: string,
	instanceId: string,
	keep: KeepArtifact,
	tally: Tally,
): Promise<void> => {
	const names = await listReplayNames(transport, directory)
	if (names === undefined) {
		tally.failed += 1
		return
	}
	for (const name of names) {
		const path = `${directory}/${name}`
		const encoded = await readBase64(transport, path, MAX_ARTIFACT_BYTES + 1)
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
			await keep(instanceId, artifact)
		} catch {
			tally.failed += 1
			continue
		}
		if (!(await removeFile(transport, path))) {
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
			`find ${shellQuote(directory)} -maxdepth 1 -type f -name '*.mcpr' -mtime +${REPLAY_KEEP_DAYS} -print -delete 2>/dev/null | wc -l`,
			ARTIFACT_STEP_TIMEOUT_MS,
		)
		tally.replaysPruned += countFrom(result.stdout)
	} catch {
		tally.failed += 1
	}
}

const pruneRecordingCache = async (
	transport: HostTransport,
	directory: string,
	tally: Tally,
): Promise<void> => {
	const quoted = shellQuote(directory)
	try {
		const result = await transport.exec(
			`find ${quoted} -type f -mmin +${ORPHANED_CACHE_MINUTES} -delete 2>/dev/null; find ${quoted} -mindepth 1 -type d -empty -print -delete 2>/dev/null | wc -l`,
			ARTIFACT_STEP_TIMEOUT_MS,
		)
		tally.cacheDirectoriesPruned += countFrom(result.stdout)
	} catch {
		tally.failed += 1
	}
}

const measureMailerState = async (
	transport: HostTransport,
	directory: string,
	names: ArtifactNames,
	tally: Tally,
): Promise<void> => {
	if (names.mailerDatabase === undefined || names.mailerIgnoreList === undefined) {
		tally.refused += 1
		return
	}
	const database = shellQuote(`${directory}/${names.mailerDatabase}`)
	const ignoreList = shellQuote(`${directory}/${names.mailerIgnoreList}`)
	try {
		const result = await transport.exec(
			`printf '%s %s' "$(wc -c < ${database} 2>/dev/null || printf 0)" "$(wc -c < ${ignoreList} 2>/dev/null || printf 0)"`,
			ARTIFACT_STEP_TIMEOUT_MS,
		)
		tally.mailerStateBytes += mailerStateBytesFrom(result.stdout)
	} catch {
		tally.failed += 1
	}
}

export const sweepHostArtifacts = async (
	transport: HostTransport,
	profile: HostProfile,
	instances: readonly InstanceRow[],
	documents: ReadonlyMap<string, string>,
	keep: KeepArtifact,
): Promise<readonly InstanceArtifactSweep[]> => {
	const sweeps: InstanceArtifactSweep[] = []
	for (const instance of instances) {
		const directory = instanceDir(profile.instancesRoot, instance.id)
		const names = artifactNamesFor(documents.get(instance.id))
		const tally = emptyTally()

		if (names.playerList === undefined) tally.refused += 1
		else await collectPlayerList(transport, directory, names.playerList, instance.id, keep, tally)

		const replays = `${directory}/${REPLAY_DIRECTORY}`
		await collectReplays(transport, replays, instance.id, keep, tally)
		await pruneReplays(transport, replays, tally)
		await pruneRecordingCache(transport, `${directory}/${RECORDING_CACHE_DIRECTORY}`, tally)
		await measureMailerState(transport, directory, names, tally)

		sweeps.push({
			instanceId: instance.id,
			collected: tally.collected,
			kindsCollected: [...tally.kindsCollected],
			oversize: tally.oversize,
			refused: tally.refused,
			failed: tally.failed,
			replaysPruned: tally.replaysPruned,
			cacheDirectoriesPruned: tally.cacheDirectoriesPruned,
			mailerStateBytes: tally.mailerStateBytes,
		})
	}
	return sweeps
}

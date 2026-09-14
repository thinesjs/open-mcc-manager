import type { InstanceArtifactKind } from "@open-mcc/contracts"
import type { HostRow, InstanceRow } from "@open-mcc/db"
import type { HostTransport } from "@open-mcc/transport"
import { isPollable } from "../host/health-poller"
import type { OrgScope } from "../host/host.repository"
import type { Logger } from "../log/logger"
import { cutoffFor } from "../notification/retention"
import {
	ARTIFACT_RETENTION_DAYS,
	ARTIFACTS_KEPT_PER_KIND,
	type InstanceArtifactSweep,
	MAILER_STATE_WARN_BYTES,
	sweepHostArtifacts,
} from "./artifact"
import type { ArtifactValues } from "./artifact.repository"

export type ArtifactCollectRun = {
	readonly hosts: number
	readonly unreachable: number
	readonly collected: number
	readonly oversize: number
	readonly refused: number
	readonly failed: number
	readonly replaysPruned: number
	readonly cacheDirectoriesPruned: number
	readonly storedPruned: number
	readonly mailerStateOverBudget: number
}

export type ArtifactCollectDeps = {
	readonly organizationIds: () => Promise<readonly string[]>
	readonly hosts: (scope: OrgScope) => Promise<readonly HostRow[]>
	readonly instancesOn: (scope: OrgScope, hostId: string) => Promise<readonly InstanceRow[]>
	readonly savedDocument: (scope: OrgScope, instanceId: string) => Promise<string | undefined>
	readonly connect: (host: HostRow) => Promise<HostTransport>
	readonly store: (scope: OrgScope, values: ArtifactValues) => Promise<boolean>
	readonly deleteBeyondKept: (
		scope: OrgScope,
		instanceId: string,
		kind: InstanceArtifactKind,
		kept: number,
	) => Promise<number>
	readonly deleteCollectedBefore: (scope: OrgScope, cutoff: Date) => Promise<number>
	readonly now: () => Date
	readonly onError?: (message: string, error: Error | string) => void
}

const documentsFor = async (
	deps: ArtifactCollectDeps,
	scope: OrgScope,
	instances: readonly InstanceRow[],
): Promise<ReadonlyMap<string, string>> => {
	const documents = new Map<string, string>()
	for (const instance of instances) {
		const document = await deps.savedDocument(scope, instance.id)
		if (document !== undefined) documents.set(instance.id, document)
	}
	return documents
}

export const createArtifactCollector =
	(deps: ArtifactCollectDeps) => async (): Promise<ArtifactCollectRun> => {
		const now = deps.now()
		const cutoff = cutoffFor(now, ARTIFACT_RETENTION_DAYS)
		let hosts = 0
		let unreachable = 0
		let collected = 0
		let oversize = 0
		let refused = 0
		let failed = 0
		let replaysPruned = 0
		let cacheDirectoriesPruned = 0
		let storedPruned = 0
		let mailerStateOverBudget = 0

		for (const organizationId of await deps.organizationIds()) {
			const scope = { organizationId }
			for (const host of (await deps.hosts(scope)).filter(isPollable)) {
				hosts += 1
				const instances = await deps.instancesOn(scope, host.id)
				const documents = await documentsFor(deps, scope, instances)

				let sweeps: readonly InstanceArtifactSweep[] = []
				let transport: HostTransport | undefined
				try {
					transport = await deps.connect(host)
					sweeps = await sweepHostArtifacts(
						transport,
						instances,
						documents,
						async (instanceId, artifact) => {
							await deps.store(scope, {
								instanceId,
								kind: artifact.kind,
								content: artifact.content,
								digest: artifact.digest,
								collectedAt: now,
							})
						},
					)
				} catch (error) {
					unreachable += 1
					deps.onError?.(
						`Artifact collection could not reach host ${host.id}`,
						error instanceof Error ? error : String(error),
					)
				} finally {
					await transport?.close().catch(() => undefined)
				}

				for (const sweep of sweeps) {
					collected += sweep.collected
					oversize += sweep.oversize
					refused += sweep.refused
					failed += sweep.failed
					replaysPruned += sweep.replaysPruned
					cacheDirectoriesPruned += sweep.cacheDirectoriesPruned
					if (sweep.mailerStateBytes > MAILER_STATE_WARN_BYTES) mailerStateOverBudget += 1
					for (const kind of sweep.kindsCollected) {
						storedPruned += await deps.deleteBeyondKept(
							scope,
							sweep.instanceId,
							kind,
							ARTIFACTS_KEPT_PER_KIND,
						)
					}
				}
			}
			storedPruned += await deps.deleteCollectedBefore(scope, cutoff)
		}

		return {
			hosts,
			unreachable,
			collected,
			oversize,
			refused,
			failed,
			replaysPruned,
			cacheDirectoriesPruned,
			storedPruned,
			mailerStateOverBudget,
		}
	}

export type ArtifactCollectReporter = (run: ArtifactCollectRun) => void

export const artifactCollectReporter =
	(logger: Pick<Logger, "info" | "warn">): ArtifactCollectReporter =>
	(run) => {
		if (run.collected > 0 || run.replaysPruned > 0 || run.cacheDirectoriesPruned > 0) {
			logger.info(
				`Collected ${run.collected} instance artifacts and freed ${run.replaysPruned} replays and ${run.cacheDirectoriesPruned} recording caches`,
			)
		}
		if (run.oversize > 0 || run.refused > 0 || run.failed > 0) {
			logger.warn(
				`Left ${run.oversize} artifacts too large to carry, ${run.refused} unusable and ${run.failed} uncollected`,
			)
		}
		if (run.mailerStateOverBudget > 0) {
			logger.warn(
				`${run.mailerStateOverBudget} instance(s) hold more than ${MAILER_STATE_WARN_BYTES} bytes of Mailer state, which the control plane cannot collect`,
			)
		}
	}

export type ArtifactCollect = () => Promise<void>

export const artifactCollectJob =
	(collect: () => Promise<ArtifactCollectRun>, report: ArtifactCollectReporter): ArtifactCollect =>
	async () =>
		report(await collect())

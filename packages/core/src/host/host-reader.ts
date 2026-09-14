import type { HostRow } from "@open-mcc/db"
import {
	type ConnectionIdentity,
	type HostReader,
	type ReadConnections,
	sameConnectionIdentity,
} from "@open-mcc/transport"
import type { SecretStore } from "../crypto/sealed-box"
import type { SshKeyRepository } from "../ssh-key/ssh-key.repository"
import { CONNECT_TIMEOUT_MS, HostUnreachableError } from "./host.controller"
import type { HostRepository, OrgScope } from "./host.repository"
import { COULD_NOT_CONNECT, connectFailureReason } from "./unreachable"

export type HostReaderDeps = {
	hosts: Pick<HostRepository, "findById">
	sshKeys: Pick<SshKeyRepository, "findById">
	secrets: Pick<SecretStore, "open">
	readConnections: Pick<ReadConnections, "lease">
}

export type HostReadLease =
	| { kind: "leased"; reader: HostReader; host: HostRow }
	| { kind: "missing" }
	| { kind: "unprovisioned" }
	| { kind: "changed" }

class SshKeyGoneError extends Error {}

export const hostReadKey = (organizationId: string, hostId: string): string =>
	`${organizationId}:${hostId}`

const identityOf = (host: HostRow): ConnectionIdentity | undefined => {
	if (host.teardownRequestedAt !== null || !host.sshKeyId || !host.hostKeyFingerprint) {
		return undefined
	}
	return {
		hostname: host.hostname,
		port: host.port,
		username: host.username,
		sshKeyId: host.sshKeyId,
		hostKeyFingerprint: host.hostKeyFingerprint,
	}
}

export const leaseHostReader = async (
	deps: HostReaderDeps,
	scope: OrgScope,
	hostId: string,
	deadlineMs: number,
): Promise<HostReadLease> => {
	const host = await deps.hosts.findById(scope, hostId)
	const identity = host ? identityOf(host) : undefined
	if (!host || !identity) return { kind: "missing" }
	if (host.osRelease === null) return { kind: "unprovisioned" }

	let reader: HostReader
	try {
		reader = await deps.readConnections.lease(
			hostReadKey(scope.organizationId, hostId),
			identity,
			deadlineMs,
			async (transport) => {
				const key = await deps.sshKeys.findById(scope, identity.sshKeyId)
				if (!key) throw new SshKeyGoneError(`Ssh key not found for host ${hostId}`)
				try {
					await transport.connect({
						hostname: identity.hostname,
						port: identity.port,
						username: identity.username,
						privateKey: deps.secrets.open(key.privateKeyEncrypted, key.privateKeyKeyId),
						expectedFingerprint: identity.hostKeyFingerprint,
						timeoutMs: CONNECT_TIMEOUT_MS,
					})
				} catch (error) {
					throw new HostUnreachableError(
						error instanceof Error ? connectFailureReason(error) : COULD_NOT_CONNECT,
					)
				}
			},
		)
	} catch (error) {
		if (error instanceof SshKeyGoneError) return { kind: "missing" }
		throw error
	}

	let current: HostRow | undefined
	try {
		current = await deps.hosts.findById(scope, hostId)
	} catch (error) {
		reader.release()
		throw error
	}
	const stillTrusted = current ? identityOf(current) : undefined
	if (!current || !stillTrusted || current.osRelease === null) {
		reader.release()
		return { kind: "missing" }
	}
	if (!sameConnectionIdentity(stillTrusted, identity)) {
		reader.release()
		return { kind: "changed" }
	}
	return { kind: "leased", reader, host: current }
}

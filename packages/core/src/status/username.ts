import { instanceConfigStored, minecraftNameOf } from "@open-mcc/contracts"
import type { InstanceConfigRow, InstanceRow } from "@open-mcc/db"
import type { HostReader } from "@open-mcc/transport"
import { LIVE_CONTROL_ROUTE } from "../instance/config"
import { readSessionStatus } from "../instance/live-control"

export type UsernameDeps = {
	latestConfig: (instanceId: string) => Promise<InstanceConfigRow | undefined>
	openToken: (sealed: string, keyId: string) => string
	reader: () => Promise<HostReader | undefined>
}

export const resolveMinecraftName = async (
	instance: InstanceRow,
	deps: UsernameDeps,
): Promise<string | undefined> => {
	const offline = minecraftNameOf(instance)
	if (offline !== null) return offline

	if (!instance.liveControlTokenEncrypted || !instance.liveControlTokenKeyId) return undefined
	const saved = await deps.latestConfig(instance.id)
	if (!saved) return undefined
	const config = instanceConfigStored.safeParse(saved.document)
	if (!config.success || !config.data.liveControlEnabled) return undefined

	const token = deps.openToken(instance.liveControlTokenEncrypted, instance.liveControlTokenKeyId)
	try {
		const reader = await deps.reader()
		if (!reader) return undefined
		try {
			const status = await readSessionStatus({
				reader,
				port: instance.liveControlPort,
				route: LIVE_CONTROL_ROUTE,
				token,
			})
			return status.username
		} finally {
			reader.release()
		}
	} catch {
		return undefined
	}
}

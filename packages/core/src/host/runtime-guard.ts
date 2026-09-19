import type { HostRow } from "@open-mcc/db"
import { assertExhaustive } from "../lib/exhaustive"

type RuntimeField = "networkStack" | "architecture"

export type RuntimeHost = Omit<HostRow, RuntimeField> & {
	[Field in RuntimeField]: NonNullable<HostRow[Field]>
}

export type HostRuntimeCheck =
	| { kind: "ready"; host: RuntimeHost }
	| { kind: "missing"; missing: RuntimeField[] }

export const checkHostRuntime = (host: HostRow): HostRuntimeCheck => {
	const { networkStack, architecture } = host
	if (networkStack !== null && architecture !== null) {
		return { kind: "ready", host: { ...host, networkStack, architecture } }
	}
	const missing: RuntimeField[] = []
	if (networkStack === null) missing.push("networkStack")
	if (architecture === null) missing.push("architecture")
	return { kind: "missing", missing }
}

export type HostNeed = "setUpOnce" | "runtime"

export const hostMeets = (host: HostRow, need: HostNeed): boolean => {
	if (host.osRelease === null) return false
	switch (need) {
		case "setUpOnce":
			return true
		case "runtime":
			return checkHostRuntime(host).kind === "ready"
		default:
			return assertExhaustive(need)
	}
}

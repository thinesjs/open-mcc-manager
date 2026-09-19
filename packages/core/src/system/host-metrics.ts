import type { HostMetrics } from "@open-mcc/contracts"
import { asReadCommand, type HostReader } from "@open-mcc/transport"
import { INSTANCES_ROOT } from "../host/profile"
import { HostRefusedError } from "../lib/errors"

export const HOST_METRICS_TIMEOUT_MS = 15_000

export type { HostMetrics }

export const HOST_METRICS_COMMAND = [
	"cut -d' ' -f1 /proc/loadavg",
	"awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{print t, a}' /proc/meminfo",
	"cut -d' ' -f1 /proc/uptime",
].join("; ")

const number = (value: string | undefined): number => {
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

export const parseHostMetrics = (stdout: string, diskStdout: string): HostMetrics => {
	const [load = "", memory = "", uptime = ""] = stdout.trim().split("\n")
	const [totalKb, availableKb] = memory.trim().split(/\s+/)
	const total = number(totalKb)
	const available = number(availableKb)
	const [, blocksKb = "", usedKb = ""] = diskStdout.trim().split(/\s+/)

	return {
		loadAverage1m: number(load.trim()),
		memoryUsedMb: Math.round((total - available) / 1024),
		memoryTotalMb: Math.round(total / 1024),
		diskUsedMb: Math.round(number(usedKb) / 1024),
		diskTotalMb: Math.round(number(blocksKb) / 1024),
		uptimeSeconds: Math.floor(number(uptime.trim())),
	}
}

export const readHostMetrics = async (reader: Pick<HostReader, "exec">): Promise<HostMetrics> => {
	const general = await reader.exec(asReadCommand(HOST_METRICS_COMMAND))
	if (general.exitCode !== 0) {
		throw new HostRefusedError(`Could not read host metrics: ${general.stderr.trim()}`)
	}
	const disk = await reader.exec(asReadCommand(`df -Pk ${INSTANCES_ROOT} 2>/dev/null | tail -n 1`))
	return parseHostMetrics(general.stdout, disk.stdout)
}

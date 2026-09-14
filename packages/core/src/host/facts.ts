import type { HostTransport } from "@open-mcc/transport"

export const FACT_TIMEOUT_MS = 15_000

export const CPU_COUNT_COMMAND = "nproc 2>/dev/null || printf 0"

export const MEMORY_TOTAL_COMMAND =
	"awk '/MemTotal/ {print $2; exit}' /proc/meminfo 2>/dev/null || printf 0"

export const OS_RELEASE_COMMAND =
	'. /etc/os-release 2>/dev/null; printf \'%s\\n%s\' "$ID" "$PRETTY_NAME"'

export const UNKNOWN_HOST_FACT = "Unknown"

const HOST_FACT_SHAPE = /^[ -~]{1,128}$/

export const hostFact = (output: string): string | null => {
	const value = output.trim().replace(/^"|"$/g, "")
	if (value.length === 0) return null
	return HOST_FACT_SHAPE.test(value) ? value : UNKNOWN_HOST_FACT
}

export const parseOsRelease = (output: string): { osId: string | null; osName: string | null } => {
	const [id = "", name = ""] = output.split("\n")
	return { osId: hostFact(id), osName: hostFact(name) }
}

export const parseCount = (output: string): number | null => {
	const value = Number.parseInt(output.trim(), 10)
	return Number.isSafeInteger(value) && value > 0 ? value : null
}

export const parseMemoryMb = (output: string): number | null => {
	const kb = parseCount(output)
	return kb === null ? null : Math.round(kb / 1024)
}

export type HostFacts = {
	osRelease: string | null
	osId: string | null
	osName: string | null
	cpuCount: number | null
	memoryMb: number | null
}

export const readHostFacts = async (transport: HostTransport): Promise<HostFacts> => {
	const version = await transport.exec("systemctl --version | head -n 1", FACT_TIMEOUT_MS)
	const os = await transport.exec(OS_RELEASE_COMMAND, FACT_TIMEOUT_MS)
	const cpu = await transport.exec(CPU_COUNT_COMMAND, FACT_TIMEOUT_MS)
	const memory = await transport.exec(MEMORY_TOTAL_COMMAND, FACT_TIMEOUT_MS)

	return {
		osRelease: hostFact(version.stdout),
		...parseOsRelease(os.stdout),
		cpuCount: parseCount(cpu.stdout),
		memoryMb: parseMemoryMb(memory.stdout),
	}
}

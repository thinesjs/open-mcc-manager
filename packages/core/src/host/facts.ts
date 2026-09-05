import type { HostTransport } from "@open-mcc/transport"
import type { HostProfile } from "./profile"

export const FACT_TIMEOUT_MS = 15_000

export const CPU_COUNT_COMMAND = "nproc 2>/dev/null || printf 0"

export const MEMORY_TOTAL_COMMAND =
	"awk '/MemTotal/ {print $2; exit}' /proc/meminfo 2>/dev/null || printf 0"

export const OS_RELEASE_COMMAND =
	'. /etc/os-release 2>/dev/null; printf \'%s\\n%s\' "$ID" "$PRETTY_NAME"'

export const SANDBOX_PROBE_MARKER = "/tmp/.open-mcc-sandbox-probe"

export const SANDBOX_PROBE_UNIT = "open-mcc-sandbox-probe"

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

export const sandboxProbeCommand = (marker: string = SANDBOX_PROBE_MARKER): string => {
	const quoted = shellQuote(marker)
	const run = `systemd-run --user --wait --collect --quiet --unit=${SANDBOX_PROBE_UNIT} --property=PrivateTmp=yes /bin/sh -c ${shellQuote(`touch ${marker}`)}`
	return `rm -f ${quoted}; ${run} >/dev/null 2>&1; if [ -e ${quoted} ]; then rm -f ${quoted}; printf ignored; else printf enforced; fi`
}

export const readsAsEnforced = (output: string): boolean => output.trim() === "enforced"

export const parseOsRelease = (output: string): { osId: string | null; osName: string | null } => {
	const [id = "", name = ""] = output.split("\n")
	const clean = (value: string): string | null => {
		const trimmed = value.trim().replace(/^"|"$/g, "")
		return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : null
	}
	return { osId: clean(id), osName: clean(name) }
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
	sandboxed: boolean
	cpuCount: number | null
	memoryMb: number | null
}

export const readSandboxing = async (
	transport: HostTransport,
	profile: HostProfile,
): Promise<boolean> => {
	if (profile.mode !== "rootless") return true
	const probe = await transport.exec(sandboxProbeCommand(), FACT_TIMEOUT_MS)
	return readsAsEnforced(probe.stdout)
}

export const readHostFacts = async (
	transport: HostTransport,
	profile: HostProfile,
): Promise<HostFacts> => {
	const version = await transport.exec("systemctl --version | head -n 1", FACT_TIMEOUT_MS)
	const os = await transport.exec(OS_RELEASE_COMMAND, FACT_TIMEOUT_MS)
	const sandboxed = await readSandboxing(transport, profile)
	const cpu = await transport.exec(CPU_COUNT_COMMAND, FACT_TIMEOUT_MS)
	const memory = await transport.exec(MEMORY_TOTAL_COMMAND, FACT_TIMEOUT_MS)
	const release = version.stdout.trim()

	return {
		osRelease: release.length > 0 ? release : null,
		...parseOsRelease(os.stdout),
		sandboxed,
		cpuCount: parseCount(cpu.stdout),
		memoryMb: parseMemoryMb(memory.stdout),
	}
}

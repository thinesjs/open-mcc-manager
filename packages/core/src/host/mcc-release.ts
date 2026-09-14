import { hostFact, UNKNOWN_HOST_FACT } from "./facts"
export const MCC_VERSION = "20260829-511"

export const MCC_ARCHITECTURES = ["x64", "arm64"] as const

export type MccArchitecture = (typeof MCC_ARCHITECTURES)[number]

export type MccRelease = {
	architecture: MccArchitecture
	url: string
	sha256: string
}

const SHA256_BY_ARCHITECTURE: Record<MccArchitecture, string> = {
	x64: "2e0fe135079824d1b02a3ef9bf89c56d95d72a1d1502d7204f93acc0084223db",
	arm64: "305dc0766df3509008cc00bb4ebd6be8246f01aff7b84409e0856a98fb759925",
}

const ARCHITECTURE_BY_MACHINE: Record<string, MccArchitecture> = {
	x86_64: "x64",
	amd64: "x64",
	aarch64: "arm64",
	arm64: "arm64",
}

export class UnsupportedArchitectureError extends Error {}

export const mccDownloadUrl = (version: string, architecture: MccArchitecture): string =>
	`https://github.com/MCCTeam/Minecraft-Console-Client/releases/download/${version}/MinecraftClient-${version}-linux-${architecture}`

export const architectureForMachine = (machine: string): MccArchitecture => {
	const architecture = ARCHITECTURE_BY_MACHINE[machine.trim().toLowerCase()]
	if (!architecture) {
		throw new UnsupportedArchitectureError(
			`No Minecraft Console Client build for machine architecture '${hostFact(machine) ?? UNKNOWN_HOST_FACT}'; supported: ${Object.keys(ARCHITECTURE_BY_MACHINE).join(", ")}`,
		)
	}
	return architecture
}

export const mccReleaseForMachine = (machine: string): MccRelease => {
	const architecture = architectureForMachine(machine)
	return {
		architecture,
		url: mccDownloadUrl(MCC_VERSION, architecture),
		sha256: SHA256_BY_ARCHITECTURE[architecture],
	}
}

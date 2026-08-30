export const MCC_VERSION = "20260829-511"

export const MCC_SHA256 = "REPLACE_WITH_MEASURED_DIGEST"

export const mccDownloadUrl = (version: string): string =>
	`https://github.com/MCCTeam/Minecraft-Console-Client/releases/download/${version}/MinecraftClient-linux-x64`

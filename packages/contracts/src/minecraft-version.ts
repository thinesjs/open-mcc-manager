import { z } from "zod"

export const MINECRAFT_VERSION_AUTO = "auto"

export const MINECRAFT_VERSIONS = [
	"1.0",
	"1.0.0",
	"1.0.1",
	"1.1",
	"1.1.0",
	"1.2",
	"1.2.0",
	"1.2.1",
	"1.2.2",
	"1.2.3",
	"1.2.4",
	"1.2.5",
	"1.3",
	"1.3.0",
	"1.3.1",
	"1.3.2",
	"1.4",
	"1.4.0",
	"1.4.1",
	"1.4.2",
	"1.4.3",
	"1.4.4",
	"1.4.5",
	"1.4.6",
	"1.4.7",
	"1.5",
	"1.5.0",
	"1.5.1",
	"1.5.2",
	"1.6",
	"1.6.0",
	"1.6.1",
	"1.6.2",
	"1.6.3",
	"1.6.4",
	"1.7",
	"1.7.0",
	"1.7.1",
	"1.7.2",
	"1.7.3",
	"1.7.4",
	"1.7.5",
	"1.7.6",
	"1.7.7",
	"1.7.8",
	"1.7.9",
	"1.7.10",
	"1.8",
	"1.8.0",
	"1.8.1",
	"1.8.2",
	"1.8.3",
	"1.8.4",
	"1.8.5",
	"1.8.6",
	"1.8.7",
	"1.8.8",
	"1.8.9",
	"1.9",
	"1.9.0",
	"1.9.1",
	"1.9.2",
	"1.9.3",
	"1.9.4",
	"1.10",
	"1.10.0",
	"1.10.1",
	"1.10.2",
	"1.11",
	"1.11.0",
	"1.11.1",
	"1.11.2",
	"1.12",
	"1.12.0",
	"1.12.1",
	"1.12.2",
	"1.13",
	"1.13.0",
	"1.13.1",
	"1.13.2",
	"1.14",
	"1.14.0",
	"1.14.1",
	"1.14.2",
	"1.14.3",
	"1.14.4",
	"1.15",
	"1.15.0",
	"1.15.1",
	"1.15.2",
	"1.16",
	"1.16.0",
	"1.16.1",
	"1.16.2",
	"1.16.3",
	"1.16.4",
	"1.16.5",
	"1.17",
	"1.17.0",
	"1.17.1",
	"1.18",
	"1.18.0",
	"1.18.1",
	"1.18.2",
	"1.19",
	"1.19.0",
	"1.19.1",
	"1.19.2",
	"1.19.3",
	"1.19.4",
	"1.20",
	"1.20.1",
	"1.20.2",
	"1.20.3",
	"1.20.4",
	"1.20.5",
	"1.20.6",
	"1.21",
	"1.21.1",
	"1.21.2",
	"1.21.3",
	"1.21.4",
	"1.21.5",
	"1.21.6",
	"1.21.7",
	"1.21.8",
	"1.21.9",
	"1.21.10",
	"1.21.11",
	"26.1",
	"26.2",
] as const

export const minecraftVersionSchema = z.enum([MINECRAFT_VERSION_AUTO, ...MINECRAFT_VERSIONS])

export type MinecraftVersion = z.infer<typeof minecraftVersionSchema>

const ACCEPTED_VERSIONS: readonly string[] = MINECRAFT_VERSIONS

const bareSpellingOf = (version: string): string | undefined => {
	const parts = version.split(".")
	return parts.length === 3 && parts[2] === "0" ? `${parts[0]}.${parts[1]}` : undefined
}

export const MINECRAFT_VERSION_ALIASES: readonly string[] = ACCEPTED_VERSIONS.filter((version) => {
	const bare = bareSpellingOf(version)
	return bare !== undefined && ACCEPTED_VERSIONS.includes(bare)
})

const numbersIn = (version: string): readonly number[] => version.split(".").map(Number)

const newestFirst = (left: string, right: string): number => {
	const earlier = numbersIn(left)
	const later = numbersIn(right)
	const depth = Math.max(earlier.length, later.length)
	for (let index = 0; index < depth; index += 1) {
		const gap = (later[index] ?? 0) - (earlier[index] ?? 0)
		if (gap !== 0) return gap
	}
	return 0
}

export const MINECRAFT_VERSION_OPTIONS: readonly MinecraftVersion[] = [...MINECRAFT_VERSIONS]
	.filter((version) => !MINECRAFT_VERSION_ALIASES.includes(version))
	.sort(newestFirst)

import { RESERVED_FILE_NAMES } from "@open-mcc/contracts/boundary/mcc-config-keys"
import { describe, expect, it } from "vitest"
import { INSTANCE_UNIT_NAME, renderUnitTemplates } from "../host/unit-template"
import { RECORDING_CACHE_DIRECTORY, REPLAY_DIRECTORY } from "./artifact"
import { SESSION_CACHE_FILES } from "./authenticate"
import { CONFIG_PATH_NAME } from "./config-drift"
import { INSTANCE_LAYOUT } from "./unit"

const unreserved = (names: readonly string[]): readonly string[] =>
	names.filter((name) => !RESERVED_FILE_NAMES.includes(name))

const start =
	renderUnitTemplates({
		networkStack: "slirp4netns",
		imageId: "b54641a0139b45834e25e82fa2cf2be60bafa6a1b6a22868bb1df7182a27a7b9",
	})
		[INSTANCE_UNIT_NAME]?.split("\n")
		.find((line) => line.startsWith("ExecStart=")) ?? ""

const workingDirectory = / -w (\S+) /.exec(start)?.[1] ?? ""

const bundleBase = / -e DOTNET_BUNDLE_EXTRACT_BASE_DIR=(\S+) /.exec(start)?.[1] ?? ""

const client = / [0-9a-f]{64} (\S+) /.exec(start)?.[1] ?? ""

const mounts = [...start.matchAll(/ -v "?([^\s":]+)"?:([^\s:]+)(?::ro)?(?= )/g)].map((match) => ({
	source: match[1] ?? "",
	target: match[2] ?? "",
}))

const insideWorkingDirectory = mounts
	.map((mount) => mount.target)
	.filter((target) => target.startsWith(`${workingDirectory}/`))
	.map((target) => target.slice(workingDirectory.length + 1))

describe("★ every name the manager or the runtime places in the client's working directory is one no bot file may take", () => {
	it("runs the client in the bot's own state directory", () => {
		expect(workingDirectory).toBe("/data")
		expect(mounts.find((mount) => mount.target === workingDirectory)?.source).toBe(
			`%h/.local/share/open-mcc/instances/%i/${INSTANCE_LAYOUT.state}`,
		)
	})

	it("reserves the directory the client unpacks itself into", () => {
		expect(bundleBase).toBe(workingDirectory)
		expect(client).toMatch(/\/MinecraftClient$/)
		expect(unreserved([client.split("/").at(-1) ?? ""])).toEqual([])
	})

	it("reserves every mount point inside the working directory", () => {
		expect(insideWorkingDirectory).toEqual([REPLAY_DIRECTORY, RECORDING_CACHE_DIRECTORY])
		expect(unreserved(insideWorkingDirectory)).toEqual([])
	})

	it("reserves what the client itself writes there, Sentry included", () => {
		expect(
			unreserved(["SessionCache.db", "ProfileKeyCache.ini", "Rendered_Maps", "lang", "Sentry"]),
		).toEqual([])
	})

	it("reserves the config, the session caches and the directories the sweep works in", () => {
		expect(
			unreserved([
				CONFIG_PATH_NAME,
				...SESSION_CACHE_FILES,
				REPLAY_DIRECTORY,
				RECORDING_CACHE_DIRECTORY,
			]),
		).toEqual([])
	})
})

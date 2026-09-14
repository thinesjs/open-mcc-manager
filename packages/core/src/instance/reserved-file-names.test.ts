import { RESERVED_FILE_NAMES } from "@open-mcc/contracts/boundary/mcc-config-keys"
import { describe, expect, it } from "vitest"
import { rootlessProfile, systemProfile } from "../host/profile"
import { renderUnitTemplates } from "../host/unit-template"
import { RECORDING_CACHE_DIRECTORY, REPLAY_DIRECTORY } from "./artifact"
import { SESSION_CACHE_FILES } from "./authenticate"
import { CONFIG_PATH_NAME } from "./config-drift"

const unreserved = (names: readonly string[]): readonly string[] =>
	names.filter((name) => !RESERVED_FILE_NAMES.includes(name))

describe("★ every file this manager keeps in an instance directory is one no bot file may take", () => {
	it.each([rootlessProfile("/home/mcc"), systemProfile()])(
		"reserves each file the $mode units name inside the directory",
		(profile) => {
			const directory = `${profile.instancesRoot}/instances/%i/`
			const units = Object.values(renderUnitTemplates(profile)).join("\n")
			const named = units
				.split(directory)
				.slice(1)
				.map((rest) => rest.split(/['"\s;]/)[0] ?? "")

			expect(named.length).toBeGreaterThan(0)
			expect(unreserved(named)).toEqual([])
		},
	)

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

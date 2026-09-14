import { RESERVED_FILE_NAMES } from "@open-mcc/contracts/boundary/mcc-config-keys"
import { describe, expect, it } from "vitest"
import { renderUnitTemplates } from "../host/unit-template"
import { RECORDING_CACHE_DIRECTORY, REPLAY_DIRECTORY } from "./artifact"
import { SESSION_CACHE_FILES } from "./authenticate"
import { CONFIG_PATH_NAME } from "./config-drift"

const unreserved = (names: readonly string[]): readonly string[] =>
	names.filter((name) => !RESERVED_FILE_NAMES.includes(name))

describe("★ every file this manager keeps in an instance directory is one no bot file may take", () => {
	it("reserves each file the units name inside the directory", () => {
		const units = Object.values(renderUnitTemplates()).join("\n")
		const named = units
			.split("%h/.local/share/open-mcc/instances/%i/")
			.slice(1)
			.map((rest) => rest.split(/['"\s;]/)[0] ?? "")

		expect(named.length).toBeGreaterThan(0)
		expect(unreserved(named)).toEqual([])
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

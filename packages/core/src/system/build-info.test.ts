import { describe, expect, it } from "vitest"
import {
	DEV_VERSION,
	describeBuild,
	isDevelopmentBuild,
	readBuildInfo,
	sameBuild,
	UNKNOWN_COMMIT,
} from "./build-info"

describe("knowing which build is running", () => {
	it("reads what the image was stamped with", () => {
		expect(readBuildInfo({ APP_VERSION: "0.4.2", GIT_SHA: "abc123def456" })).toEqual({
			version: "0.4.2",
			commit: "abc123def456",
		})
	})

	it("shortens a full commit hash to something readable", () => {
		expect(readBuildInfo({ GIT_SHA: "abc123def4567890abcdef" }).commit).toBe("abc123def456")
	})

	it("says it is a development build rather than inventing a version", () => {
		const info = readBuildInfo({})

		expect(info.version).toBe(DEV_VERSION)
		expect(info.commit).toBe(UNKNOWN_COMMIT)
		expect(isDevelopmentBuild(info)).toBe(true)
	})

	it("ignores blank or absurd values a misconfigured build might pass", () => {
		expect(readBuildInfo({ APP_VERSION: "   " }).version).toBe(DEV_VERSION)
		expect(readBuildInfo({ APP_VERSION: "x".repeat(200) }).version).toBe(DEV_VERSION)
	})

	it("treats two processes as the same build only when version and commit both match", () => {
		const a = { version: "0.4.2", commit: "abc123" }

		expect(sameBuild(a, { version: "0.4.2", commit: "abc123" })).toBe(true)
		expect(sameBuild(a, { version: "0.4.2", commit: "def456" })).toBe(false)
		expect(sameBuild(a, { version: "0.4.3", commit: "abc123" })).toBe(false)
	})

	it("describes a build for display without a dangling unknown commit", () => {
		expect(describeBuild({ version: "0.4.2", commit: "abc123" })).toBe("0.4.2 (abc123)")
		expect(describeBuild({ version: "0.4.2", commit: UNKNOWN_COMMIT })).toBe("0.4.2")
	})
})

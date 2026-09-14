import { describe, expect, it } from "vitest"
import {
	compareVersions,
	isNewerThan,
	PROJECT_SOURCE,
	releasePageUrl,
	releaseVersionSchema,
	sourceOwnerSchema,
	sourceRepoSchema,
	updateSourceSchema,
} from "./update"

const ownerAccepts = (value: string) => sourceOwnerSchema.safeParse(value).success
const repoAccepts = (value: string) => sourceRepoSchema.safeParse(value).success
const isRelease = (value: string) => releaseVersionSchema.safeParse(value).success

describe("naming the account a release is checked against", () => {
	it("accepts the names GitHub gives accounts", () => {
		for (const owner of ["thinesjs", "a", "A1", "open-mcc", "a-b-c"]) {
			expect(ownerAccepts(owner), owner).toBe(true)
		}
	})

	it("refuses every character that could end the path or change where it points", () => {
		for (const owner of [
			"a/b",
			"a:b",
			"a@b",
			"a?b",
			"a#b",
			"a%2Fb",
			"a\\b",
			"a b",
			"a\nb",
			"a.b",
			"a_b",
		]) {
			expect(ownerAccepts(owner), JSON.stringify(owner)).toBe(false)
		}
	})

	it("refuses a hyphen at either end, as GitHub does", () => {
		expect(ownerAccepts("-thinesjs")).toBe(false)
		expect(ownerAccepts("thinesjs-")).toBe(false)
	})

	it("accepts thirty-nine characters and refuses forty", () => {
		expect(ownerAccepts("a".repeat(39))).toBe(true)
		expect(ownerAccepts("a".repeat(40))).toBe(false)
	})

	it("refuses an empty name", () => {
		expect(ownerAccepts("")).toBe(false)
	})
})

describe("naming the repository a release is checked against", () => {
	it("accepts the names GitHub gives repositories, dots and underscores included", () => {
		for (const repo of ["open-mcc-manager", "a", ".github", "a.b_c-d", "release..notes"]) {
			expect(repoAccepts(repo), repo).toBe(true)
		}
	})

	it("refuses a single dot, which would name the directory above", () => {
		expect(repoAccepts(".")).toBe(false)
	})

	it("refuses two dots, which would step out of the repository path", () => {
		expect(repoAccepts("..")).toBe(false)
	})

	it("refuses every character that could end the path or change where it points", () => {
		for (const repo of [
			"a/b",
			"../b",
			"a:b",
			"a@b",
			"a?b",
			"a#b",
			"a%2Fb",
			"a\\b",
			"a b",
			"a\nb",
		]) {
			expect(repoAccepts(repo), JSON.stringify(repo)).toBe(false)
		}
	})

	it("accepts a hundred characters and refuses a hundred and one", () => {
		expect(repoAccepts("a".repeat(100))).toBe(true)
		expect(repoAccepts("a".repeat(101))).toBe(false)
	})

	it("refuses an empty name", () => {
		expect(repoAccepts("")).toBe(false)
	})

	it("reads the project's own repository as a valid source", () => {
		expect(updateSourceSchema.safeParse(PROJECT_SOURCE).success).toBe(true)
	})
})

describe("what counts as a release version", () => {
	it("accepts three plain numbers", () => {
		for (const version of ["0.0.0", "1.2.3", "10.20.30", "0.10.0"]) {
			expect(isRelease(version), version).toBe(true)
		}
	})

	it("refuses a prerelease or build suffix, which the deploy path cannot carry", () => {
		for (const version of ["1.2.3-rc.1", "1.2.3+build.5", "0.0.0-dev"]) {
			expect(isRelease(version), version).toBe(false)
		}
	})

	it("refuses a leading zero in any part", () => {
		for (const version of ["01.2.3", "1.02.3", "1.2.03"]) {
			expect(isRelease(version), version).toBe(false)
		}
	})

	it("refuses anything that is not exactly three parts", () => {
		for (const version of ["1.2", "1.2.3.4", "1..3", ""]) {
			expect(isRelease(version), version).toBe(false)
		}
	})

	it("refuses a tag prefix, surrounding whitespace or a trailing newline", () => {
		for (const version of ["v1.2.3", " 1.2.3", "1.2.3 ", "1.2.3\n"]) {
			expect(isRelease(version), JSON.stringify(version)).toBe(false)
		}
	})
})

describe("comparing two release versions", () => {
	it("compares each part as a number, so 0.10.0 is newer than 0.9.0", () => {
		expect(compareVersions("0.10.0", "0.9.0")).toBe(1)
		expect(compareVersions("0.9.0", "0.10.0")).toBe(-1)
	})

	it("lets a higher major win over any minor or patch", () => {
		expect(compareVersions("1.0.0", "0.99.99")).toBe(1)
	})

	it("lets a higher minor win over any patch", () => {
		expect(compareVersions("1.2.0", "1.1.99")).toBe(1)
	})

	it("reads the same version as equal", () => {
		expect(compareVersions("1.4.0", "1.4.0")).toBe(0)
	})

	it("stays exact on a part too large for a double to hold", () => {
		expect(compareVersions("9007199254740993.0.0", "9007199254740992.0.0")).toBe(1)
	})

	it("gives no answer when either side is not a release version", () => {
		expect(compareVersions("0.0.0-dev", "1.0.0")).toBeUndefined()
		expect(compareVersions("1.0.0", "1.0")).toBeUndefined()
	})
})

describe("the one link the dashboard builds", () => {
	it("points at the release page for the version, built from the source", () => {
		expect(releasePageUrl({ owner: "thinesjs", repo: "open-mcc-manager" }, "1.5.0")).toBe(
			"https://github.com/thinesjs/open-mcc-manager/releases/tag/v1.5.0",
		)
	})
})

describe("whether a release is newer than the running build", () => {
	it("says yes to a newer release", () => {
		expect(isNewerThan("1.5.0", "1.4.0")).toBe(true)
	})

	it("refuses an older release that really exists, which is the silent downgrade", () => {
		expect(isNewerThan("1.3.9", "1.4.0")).toBe(false)
	})

	it("refuses the version that is already running", () => {
		expect(isNewerThan("1.4.0", "1.4.0")).toBe(false)
	})

	it("refuses when the running build has no release version to compare against", () => {
		expect(isNewerThan("1.5.0", "0.0.0-dev")).toBe(false)
	})

	it("refuses a candidate that is not a release version", () => {
		expect(isNewerThan("1.5.0-rc.1", "1.4.0")).toBe(false)
	})
})

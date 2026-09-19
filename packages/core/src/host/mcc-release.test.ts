import { describe, expect, it } from "vitest"
import {
	MCC_ARCHITECTURES,
	MCC_VERSION,
	mccReleaseForMachine,
	UnsupportedArchitectureError,
} from "./mcc-release"

describe("mcc release selection", () => {
	it("maps what uname -m actually prints on the platforms hosts run", () => {
		expect(mccReleaseForMachine("x86_64").architecture).toBe("x64")
		expect(mccReleaseForMachine("aarch64").architecture).toBe("arm64")
	})

	it("tolerates the whitespace an ssh exec leaves on the reply", () => {
		expect(mccReleaseForMachine("x86_64\n").architecture).toBe("x64")
	})

	it("refuses an architecture with no build rather than downloading the wrong binary", () => {
		expect(() => mccReleaseForMachine("armv7l")).toThrow(UnsupportedArchitectureError)
		expect(() => mccReleaseForMachine("riscv64")).toThrow(/riscv64/)
	})

	it("builds a url whose asset name carries the version, as the release actually publishes it", () => {
		expect(mccReleaseForMachine("x86_64").url).toBe(
			`https://github.com/MCCTeam/Minecraft-Console-Client/releases/download/${MCC_VERSION}/MinecraftClient-${MCC_VERSION}-linux-x64`,
		)
	})

	it("pins a measured digest for every architecture it will install", () => {
		for (const architecture of MCC_ARCHITECTURES) {
			const release = mccReleaseForMachine(architecture === "x64" ? "x86_64" : "aarch64")
			expect(release.sha256).toMatch(/^[0-9a-f]{64}$/)
			expect(release.sha256).not.toContain("REPLACE")
		}
	})
})

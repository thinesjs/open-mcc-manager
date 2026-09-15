import { describe, expect, it } from "vitest"
import { MCC_ARCHITECTURES } from "./mcc-release"
import { RUNTIME_IMAGE_REPOSITORY, runtimeImageFor, runtimeImageReference } from "./runtime-image"

describe("the image every bot runs in", () => {
	it("is Microsoft's .NET runtime image, taken from its registry", () => {
		expect(RUNTIME_IMAGE_REPOSITORY).toBe("mcr.microsoft.com/dotnet/runtime-deps")
	})

	it("pins the arm64 build by manifest digest and image ID", () => {
		expect(runtimeImageFor("arm64")).toEqual({
			manifest: "sha256:003addb8550309e7cd6886ff29175c4c6d926cb920eb9966bda388fe9d682062",
			imageId: "sha256:b54641a0139b45834e25e82fa2cf2be60bafa6a1b6a22868bb1df7182a27a7b9",
		})
	})

	it("pins the amd64 build by manifest digest and image ID", () => {
		expect(runtimeImageFor("x64")).toEqual({
			manifest: "sha256:4d2c0a932f7b69603fe2ff643bd1f481914e154c4d5076691716bd23319bb12f",
			imageId: "sha256:56e3d8542b4091c81816101e95875e32ec981577e669112c479a57d4003e4c29",
		})
	})

	it("pins a different image for each architecture the client ships", () => {
		const pinned = MCC_ARCHITECTURES.map((architecture) => runtimeImageFor(architecture))

		expect(new Set(pinned.map((image) => image.manifest)).size).toBe(MCC_ARCHITECTURES.length)
		expect(new Set(pinned.map((image) => image.imageId)).size).toBe(MCC_ARCHITECTURES.length)
	})

	it("names the image by its manifest digest, never by a tag that moves", () => {
		expect(runtimeImageReference(runtimeImageFor("arm64"))).toBe(
			"mcr.microsoft.com/dotnet/runtime-deps@sha256:003addb8550309e7cd6886ff29175c4c6d926cb920eb9966bda388fe9d682062",
		)
	})
})

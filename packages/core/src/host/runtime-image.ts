import type { MccArchitecture } from "./mcc-release"

export const RUNTIME_IMAGE_REPOSITORY = "mcr.microsoft.com/dotnet/runtime-deps"

const PINNED = {
	x64: {
		manifest: "sha256:4d2c0a932f7b69603fe2ff643bd1f481914e154c4d5076691716bd23319bb12f",
		imageId: "sha256:56e3d8542b4091c81816101e95875e32ec981577e669112c479a57d4003e4c29",
	},
	arm64: {
		manifest: "sha256:003addb8550309e7cd6886ff29175c4c6d926cb920eb9966bda388fe9d682062",
		imageId: "sha256:b54641a0139b45834e25e82fa2cf2be60bafa6a1b6a22868bb1df7182a27a7b9",
	},
} as const

export type RuntimeImage = (typeof PINNED)[MccArchitecture]

export const runtimeImageFor = (architecture: MccArchitecture): RuntimeImage => PINNED[architecture]

export const runtimeImageReference = (image: RuntimeImage): string =>
	`${RUNTIME_IMAGE_REPOSITORY}@${image.manifest}`

export const podmanImageId = (image: RuntimeImage): string => image.imageId.replace(/^sha256:/, "")

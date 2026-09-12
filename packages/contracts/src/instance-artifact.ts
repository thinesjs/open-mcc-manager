export const INSTANCE_ARTIFACT_KINDS = ["playerList", "replay"] as const

export type InstanceArtifactKind = (typeof INSTANCE_ARTIFACT_KINDS)[number]

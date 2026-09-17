import { z } from "zod"
import { hostKeyFingerprint } from "./host"

export const SELF_HOST_REACHES = ["proven", "reachable", "unproven"] as const

export const selfHostReach = z.enum(SELF_HOST_REACHES)

export type SelfHostReach = z.infer<typeof selfHostReach>

export const selfHostOffer = z.object({
	name: z.string().min(1).max(64),
	hostname: z.string().min(1).max(255),
	port: z.number().int().min(1).max(65535),
	username: z.string().min(1).max(64),
	fingerprint: hostKeyFingerprint,
	reach: selfHostReach,
	systemd: z.boolean(),
	linger: z.boolean(),
})

export type SelfHostOffer = z.infer<typeof selfHostOffer>

export const selfHostPublicOffer = selfHostOffer.omit({ fingerprint: true })

export type SelfHostPublicOffer = z.infer<typeof selfHostPublicOffer>

export const canAdoptSelfHost = (offer: SelfHostPublicOffer): boolean =>
	offer.reach === "proven" && offer.systemd

export const needsLinger = (offer: SelfHostPublicOffer): boolean => !offer.linger

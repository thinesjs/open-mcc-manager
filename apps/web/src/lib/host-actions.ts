import { type Capability, can, type Role } from "@open-mcc/contracts"

export const HOST_CONTROLS = ["createInstance", "setUp", "remove"] as const

export type HostControl = (typeof HOST_CONTROLS)[number]

const NEEDED: Record<HostControl, Capability> = {
	createInstance: "instance.create",
	setUp: "host.enroll",
	remove: "host.enroll",
}

export const mayUseHostControl = (role: Role | undefined, control: HostControl): boolean =>
	role !== undefined && can(role, NEEDED[control])

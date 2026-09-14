import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { exec, ROOT, remove, startHost } from "./sandbox"

const KERNEL_WRITERS = [
	"systemd-sysctl.service",
	"systemd-binfmt.service",
	"systemd-modules-load.service",
]

let host = ""

beforeAll(async () => {
	host = await startHost(inject("sandbox"))
})

afterAll(async () => {
	await remove(host)
})

describe("the sandbox host itself", () => {
	it.each(KERNEL_WRITERS.map((unit) => ({ unit })))(
		"never runs $unit, which would change the kernel of the machine running the suite",
		async ({ unit }) => {
			const state = await exec(host, ROOT, ["systemctl", "is-enabled", unit])

			expect(state.stdout.trim()).toBe("masked")
		},
	)
})

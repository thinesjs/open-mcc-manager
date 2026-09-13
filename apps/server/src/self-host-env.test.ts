import { describe, expect, it } from "vitest"
import type { Env } from "./env"
import { selfHostConfigured, selfHostMaterialsFrom } from "./self-host-env"

const FINGERPRINT = "SHA256:5t0oGkKIrpBGw7Z4LrnOdxM6wJzJPuK+aQ8N9sVhP1c"

const BASE: Env = {
	DATABASE_URL: "postgres://nobody:nobody@127.0.0.1:1/nope",
	PORT: 3000,
	STATUS_RETENTION_DAYS: 30,
	BETTER_AUTH_SECRET: "a-very-long-test-secret-value-000000",
	BETTER_AUTH_URL: "http://localhost:3000",
	SEALBOX_KEYS: "k1:aaa:bbb",
	ALLOWED_ORIGINS: "http://localhost:5173",
	NOTIFICATION_ALLOW_HTTP: false,
	NOTIFICATION_ALLOWED_HOSTS: "",
	NOTIFICATION_ALLOWED_ADDRESSES: "",
	NOTIFICATION_TEAMS_HOSTS: "",
	OTEL_EXPORTER_OTLP_ENDPOINT: "",
}

const INSTALLED: Env = {
	...BASE,
	SELF_HOST_NAME: "kitchen-pi",
	SELF_HOST_HOSTNAME: "host.docker.internal",
	SELF_HOST_PORT: "22",
	SELF_HOST_USERNAME: "mcc",
	SELF_HOST_MODE: "rootless",
	SELF_HOST_FINGERPRINT: FINGERPRINT,
	SELF_HOST_PUBLIC_KEY: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA open-mcc:this-machine",
	SELF_HOST_PRIVATE_KEY_SEALED: "Xj+9/abcDEF==ghi+/jkl",
	SELF_HOST_PRIVATE_KEY_ID: "k1",
	SELF_HOST_REACH: "proven",
	SELF_HOST_SYSTEMD: "yes",
	SELF_HOST_LINGER: "yes",
}

describe("reading what the installer appended", () => {
	it("describes the machine it names, with the sealed key kept apart from the offer", () => {
		expect(selfHostMaterialsFrom(INSTALLED)).toEqual({
			offer: {
				name: "kitchen-pi",
				hostname: "host.docker.internal",
				port: 22,
				username: "mcc",
				mode: "rootless",
				fingerprint: FINGERPRINT,
				reach: "proven",
				systemd: true,
				linger: true,
			},
			publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA open-mcc:this-machine",
			privateKeyEncrypted: "Xj+9/abcDEF==ghi+/jkl",
			privateKeyKeyId: "k1",
		})
	})

	it("describes nothing, and is not configured, when the installer appended nothing", () => {
		expect(selfHostMaterialsFrom(BASE)).toBeUndefined()
		expect(selfHostConfigured(BASE)).toBe(false)
	})

	it("counts blank values as nothing, which is what compose passes for an unset one", () => {
		const blank: Env = { ...BASE, SELF_HOST_NAME: "", SELF_HOST_PORT: "  " }

		expect(selfHostConfigured(blank)).toBe(false)
	})

	it("reads only yes as yes, so an unknown lingering state is never taken for on", () => {
		const unknown = selfHostMaterialsFrom({ ...INSTALLED, SELF_HOST_LINGER: "unknown" })
		const off = selfHostMaterialsFrom({ ...INSTALLED, SELF_HOST_SYSTEMD: "no" })

		expect(unknown?.offer.linger).toBe(false)
		expect(off?.offer.systemd).toBe(false)
	})

	it.each([
		{ field: "SELF_HOST_PORT", value: "twenty-two" },
		{ field: "SELF_HOST_PORT", value: "" },
		{ field: "SELF_HOST_PORT", value: "70000" },
		{ field: "SELF_HOST_FINGERPRINT", value: "SHA256:short" },
		{ field: "SELF_HOST_MODE", value: "sudo" },
		{ field: "SELF_HOST_REACH", value: "probably" },
		{ field: "SELF_HOST_PRIVATE_KEY_SEALED", value: "" },
		{ field: "SELF_HOST_PRIVATE_KEY_ID", value: "" },
		{ field: "SELF_HOST_PUBLIC_KEY", value: "" },
	])(
		"offers nothing when $field is $value, rather than a card that cannot work",
		({ field, value }) => {
			const broken: Env = { ...INSTALLED, [field]: value }

			expect(selfHostMaterialsFrom(broken)).toBeUndefined()
			expect(selfHostConfigured(broken)).toBe(true)
		},
	)

	it("offers nothing when no container found an address, but still counts as configured", () => {
		const unproven: Env = { ...INSTALLED, SELF_HOST_HOSTNAME: "", SELF_HOST_REACH: "unproven" }

		expect(selfHostMaterialsFrom(unproven)).toBeUndefined()
		expect(selfHostConfigured(unproven)).toBe(true)
	})

	it("keeps an address a container could reach but not sign in to, so the card can say why", () => {
		const reachable = selfHostMaterialsFrom({ ...INSTALLED, SELF_HOST_REACH: "reachable" })

		expect(reachable?.offer.reach).toBe("reachable")
	})
})

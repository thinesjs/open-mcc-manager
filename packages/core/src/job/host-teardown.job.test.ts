import { describe, expect, it, vi } from "vitest"
import { createHostTeardownHandler } from "./host-teardown.job"

const payload = {
	hostId: "host-1",
	hostname: "vps.example.net",
	port: "2222",
	username: "mcc",
	sshKeyId: "key-1",
	hostKeyFingerprint: "SHA256:x",
	mode: "system",
	instancesRoot: "/srv/open-mcc",
	unitDir: "/etc/systemd/system",
	instanceIds: "",
	organizationId: "org-1",
}

describe("what a failed host clean-up records for the dashboard", () => {
	it("records why it could not reach the host without the address the error named", async () => {
		const onFailed = vi.fn(async (_hostId: string, _organizationId: string, _reason: string) => {})
		const handler = createHostTeardownHandler({
			openKey: async () => ({ privateKey: "PRIVATE KEY" }),
			connect: async () => {
				throw Object.assign(new Error("connect ECONNREFUSED 203.0.113.9:2222"), {
					code: "ECONNREFUSED",
				})
			},
			onCleaned: async () => {},
			onFailed,
		})

		await expect(handler(payload)).rejects.toThrow()
		expect(onFailed).toHaveBeenCalledWith("host-1", "org-1", "The server refused the connection")
	})
})

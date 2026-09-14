import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
	root: dirname(fileURLToPath(import.meta.url)),
	test: {
		include: ["*.sandbox.ts"],
		globalSetup: ["./global-setup.ts"],
		reporters: ["verbose"],
		testTimeout: 300_000,
		hookTimeout: 300_000,
	},
})

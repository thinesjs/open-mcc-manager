import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		fileParallelism: false,
		setupFiles: ["@open-mcc/config/load-env.mjs"],
		globalSetup: ["./src/test/global-setup.ts"],
	},
})

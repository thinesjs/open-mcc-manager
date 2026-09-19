import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		setupFiles: ["@open-mcc/config/load-env.mjs"],
	},
})

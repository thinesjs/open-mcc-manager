import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
	plugins: [
		tanstackRouter({
			target: "react",
			autoCodeSplitting: true,
			routeFileIgnorePattern: "\\.test\\.tsx?$",
		}),
		react(),
		tailwindcss(),
	],
	resolve: {
		alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) },
	},
	server: {
		proxy: {
			"/trpc": "http://localhost:3000",
			"/api": "http://localhost:3000",
		},
	},
})

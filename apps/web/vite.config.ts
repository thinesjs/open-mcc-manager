import "@open-mcc/config/load-env.mjs"
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
		port: Number(process.env.WEB_PORT ?? 5173),
		proxy: {
			"/trpc": process.env.SERVER_ORIGIN ?? "http://localhost:3000",
			"/api": process.env.SERVER_ORIGIN ?? "http://localhost:3000",
			"/avatars": process.env.SERVER_ORIGIN ?? "http://localhost:3000",
		},
	},
})

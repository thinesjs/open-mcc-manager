import { QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "~/index.css"

import { applyTheme, readStoredPreference, resolveTheme } from "~/lib/theme"
import { queryClient, TRPCProvider, trpcClient } from "~/lib/trpc"
import { router } from "~/router"

applyTheme(
	document.documentElement,
	resolveTheme(
		readStoredPreference(window.localStorage),
		window.matchMedia("(prefers-color-scheme: dark)").matches,
	),
)

const rootElement = document.getElementById("root")
if (!rootElement) throw new Error("Root element not found")

createRoot(rootElement).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
				<RouterProvider router={router} />
			</TRPCProvider>
		</QueryClientProvider>
	</StrictMode>,
)

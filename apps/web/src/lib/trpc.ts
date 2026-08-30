import type { AppRouter } from "@open-mcc/server"
import { QueryClient } from "@tanstack/react-query"
import { createTRPCClient, httpBatchLink } from "@trpc/client"
import { createTRPCContext } from "@trpc/tanstack-react-query"

export const queryClient = new QueryClient()

export const trpcClient = createTRPCClient<AppRouter>({
	links: [httpBatchLink({ url: "/trpc" })],
})

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>()

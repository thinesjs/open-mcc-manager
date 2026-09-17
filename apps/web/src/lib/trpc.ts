import type { AppRouter } from "@open-mcc/server"
import { QueryClient } from "@tanstack/react-query"
import { createTRPCClient, httpBatchLink } from "@trpc/client"
import { createTRPCContext } from "@trpc/tanstack-react-query"
import { wasRefused } from "./errors"

const RETRY_ATTEMPTS = 3

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			retry: (failureCount, error) => failureCount < RETRY_ATTEMPTS && !wasRefused(error),
			refetchOnWindowFocus: false,
		},
	},
})

export const trpcClient = createTRPCClient<AppRouter>({
	links: [httpBatchLink({ url: "/trpc" })],
})

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>()

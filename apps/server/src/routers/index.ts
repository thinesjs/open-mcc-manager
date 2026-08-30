import { router } from "../trpc"
import { hostRouter } from "./host.router"
import { sshKeyRouter } from "./ssh-key.router"

export const appRouter = router({
	host: hostRouter,
	sshKey: sshKeyRouter,
})

export type AppRouter = typeof appRouter

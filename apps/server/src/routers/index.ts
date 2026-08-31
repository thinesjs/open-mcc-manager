import { router } from "../trpc"
import { hostRouter } from "./host.router"
import { instanceRouter } from "./instance.router"
import { memberRouter } from "./member.router"
import { sshKeyRouter } from "./ssh-key.router"

export const appRouter = router({
	host: hostRouter,
	instance: instanceRouter,
	member: memberRouter,
	sshKey: sshKeyRouter,
})

export type AppRouter = typeof appRouter

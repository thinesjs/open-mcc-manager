import { router } from "../trpc"
import { hostRouter } from "./host.router"
import { instanceRouter } from "./instance.router"
import { memberRouter } from "./member.router"
import { notificationRouter } from "./notification.router"
import { selfHostRouter } from "./self-host.router"
import { sshKeyRouter } from "./ssh-key.router"
import { statusRouter } from "./status.router"
import { systemRouter } from "./system.router"

export const appRouter = router({
	host: hostRouter,
	system: systemRouter,
	instance: instanceRouter,
	member: memberRouter,
	status: statusRouter,
	sshKey: sshKeyRouter,
	notification: notificationRouter,
	selfHost: selfHostRouter,
})

export type AppRouter = typeof appRouter

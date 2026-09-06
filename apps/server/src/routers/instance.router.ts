import {
	createInstanceInput,
	hostIdInput,
	instanceIdInput,
	readInstanceConsoleInput,
	scheduledCommandInput,
	sendInstanceCommandInput,
	sleepWindowInput,
	updateInstanceConfigInput,
} from "@open-mcc/contracts"
import { sampleManagerMetrics } from "@open-mcc/core"
import { z } from "zod"

const nullWhenAbsent = async <T>(value: Promise<T | undefined>): Promise<T | null> =>
	(await value) ?? null

import { protectedProcedure, requireCapability, router } from "../trpc"

export const instanceRouter = router({
	list: protectedProcedure.query(({ ctx }) => {
		requireCapability(ctx.actor.role, "instance.read")
		return ctx.instanceController.list(ctx.actor)
	}),

	get: protectedProcedure.input(instanceIdInput).query(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.read")
		return ctx.instanceController.get(ctx.actor, input.instanceId)
	}),

	create: protectedProcedure.input(createInstanceInput).mutation(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.create")
		return ctx.instanceController.create(ctx.actor, input)
	}),

	start: protectedProcedure.input(instanceIdInput).mutation(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.start")
		return ctx.instanceController.start(ctx.actor, input.instanceId)
	}),

	stop: protectedProcedure.input(instanceIdInput).mutation(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.start")
		return ctx.instanceController.stop(ctx.actor, input.instanceId)
	}),

	sendCommand: protectedProcedure
		.input(sendInstanceCommandInput)
		.mutation(async ({ ctx, input }) => {
			requireCapability(ctx.actor.role, "console.write")
			await ctx.instanceController.sendCommand(ctx.actor, input.instanceId, input.command)
			return { sent: true }
		}),

	readConsole: protectedProcedure.input(readInstanceConsoleInput).query(async ({ ctx, input }) => {
		requireCapability(ctx.actor.role, "console.read")
		const output = await ctx.instanceController.readConsole(
			ctx.actor,
			input.instanceId,
			input.lines,
		)
		return { output }
	}),

	readLiveStatus: protectedProcedure.input(instanceIdInput).query(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.read")
		return nullWhenAbsent(ctx.instanceController.readLiveStatus(ctx.actor, input.instanceId))
	}),

	readLiveChat: protectedProcedure.input(instanceIdInput).query(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "console.read")
		return nullWhenAbsent(ctx.instanceController.readLiveChat(ctx.actor, input.instanceId))
	}),

	readLiveEvents: protectedProcedure.input(instanceIdInput).query(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "console.read")
		return nullWhenAbsent(ctx.instanceController.readLiveEvents(ctx.actor, input.instanceId))
	}),

	readLiveWorld: protectedProcedure.input(instanceIdInput).query(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.read")
		return nullWhenAbsent(ctx.instanceController.readLiveWorld(ctx.actor, input.instanceId))
	}),

	readLiveEntities: protectedProcedure.input(instanceIdInput).query(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.read")
		return nullWhenAbsent(ctx.instanceController.readLiveEntities(ctx.actor, input.instanceId))
	}),

	readLiveInventory: protectedProcedure.input(instanceIdInput).query(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.read")
		return nullWhenAbsent(ctx.instanceController.readLiveInventory(ctx.actor, input.instanceId))
	}),

	getConfig: protectedProcedure.input(instanceIdInput).query(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.read")
		return nullWhenAbsent(ctx.instanceController.getConfig(ctx.actor, input.instanceId))
	}),

	updateConfig: protectedProcedure
		.input(updateInstanceConfigInput)
		.mutation(async ({ ctx, input }) => {
			requireCapability(ctx.actor.role, "config.edit")
			await ctx.instanceController.updateConfig(ctx.actor, input.instanceId, input.config)
			return { updated: true }
		}),

	authenticate: protectedProcedure.input(instanceIdInput).mutation(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.authenticate")
		return ctx.instanceController.authenticate(ctx.actor, input.instanceId)
	}),

	completeAuthentication: protectedProcedure.input(instanceIdInput).mutation(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.authenticate")
		return ctx.instanceController.completeAuthentication(ctx.actor, input.instanceId)
	}),

	listScheduledCommands: protectedProcedure.input(instanceIdInput).query(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.read")
		return ctx.instanceController.listScheduledCommands(ctx.actor, input.instanceId)
	}),

	setScheduledCommand: protectedProcedure
		.input(scheduledCommandInput)
		.mutation(({ ctx, input }) => {
			requireCapability(ctx.actor.role, "console.write")
			return ctx.instanceController.setScheduledCommand(ctx.actor, input)
		}),

	deleteScheduledCommand: protectedProcedure
		.input(z.object({ id: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			requireCapability(ctx.actor.role, "console.write")
			await ctx.instanceController.deleteScheduledCommand(ctx.actor, input.id)
			return { deleted: true }
		}),

	hostMetrics: protectedProcedure.input(hostIdInput).query(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.read")
		return ctx.instanceController.hostMetrics(ctx.actor, input.hostId)
	}),

	managerMetrics: protectedProcedure.query(({ ctx }) => {
		requireCapability(ctx.actor.role, "instance.read")
		return sampleManagerMetrics({
			memoryUsage: () => process.memoryUsage(),
			uptime: () => process.uptime(),
			now: () => new Date(),
		})
	}),

	reconcileHost: protectedProcedure.input(hostIdInput).query(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.read")
		return ctx.instanceController.reconcileHost(ctx.actor, input.hostId)
	}),

	getSleepWindow: protectedProcedure.input(instanceIdInput).query(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.read")
		return ctx.instanceController.getSleepWindow(ctx.actor, input.instanceId)
	}),

	setSleepWindow: protectedProcedure.input(sleepWindowInput).mutation(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.start")
		return ctx.instanceController.setSleepWindow(ctx.actor, input)
	}),

	clearSleepWindow: protectedProcedure.input(instanceIdInput).mutation(async ({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.start")
		await ctx.instanceController.clearSleepWindow(ctx.actor, input.instanceId)
		return { cleared: true }
	}),

	remove: protectedProcedure.input(instanceIdInput).mutation(async ({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.create")
		await ctx.instanceController.remove(ctx.actor, input.instanceId)
		return { deleted: true }
	}),
})

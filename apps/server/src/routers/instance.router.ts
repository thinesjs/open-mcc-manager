import {
	createInstanceInput,
	instanceIdInput,
	readInstanceConsoleInput,
	sendInstanceCommandInput,
	updateInstanceConfigInput,
} from "@open-mcc/contracts"
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

	remove: protectedProcedure.input(instanceIdInput).mutation(async ({ ctx, input }) => {
		requireCapability(ctx.actor.role, "instance.create")
		await ctx.instanceController.remove(ctx.actor, input.instanceId)
		return { deleted: true }
	}),
})

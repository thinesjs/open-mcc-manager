import {
	createDestinationInput,
	deliveryIdInput,
	destinationIdInput,
	editDestinationInput,
	setDestinationEnabledInput,
} from "@open-mcc/contracts"
import { protectedProcedure, requireCapability, router } from "../trpc"

export const notificationRouter = router({
	list: protectedProcedure.query(({ ctx }) => {
		requireCapability(ctx.actor.role, "notification.read")
		return ctx.destinationController.list(ctx.actor)
	}),

	create: protectedProcedure.input(createDestinationInput).mutation(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "notification.manage")
		return ctx.destinationController.create(ctx.actor, input)
	}),

	edit: protectedProcedure.input(editDestinationInput).mutation(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "notification.manage")
		return ctx.destinationController.edit(ctx.actor, input)
	}),

	rotateSecret: protectedProcedure.input(destinationIdInput).mutation(async ({ ctx, input }) => {
		requireCapability(ctx.actor.role, "notification.manage")
		const signingSecret = await ctx.destinationController.rotateSecret(
			ctx.actor,
			input.destinationId,
		)
		return { signingSecret }
	}),

	setEnabled: protectedProcedure
		.input(setDestinationEnabledInput)
		.mutation(async ({ ctx, input }) => {
			requireCapability(ctx.actor.role, "notification.manage")
			const abandoned = await ctx.destinationController.setEnabled(
				ctx.actor,
				input.destinationId,
				input.enabled,
			)
			return { abandoned }
		}),

	remove: protectedProcedure.input(destinationIdInput).mutation(async ({ ctx, input }) => {
		requireCapability(ctx.actor.role, "notification.manage")
		await ctx.destinationController.remove(ctx.actor, input.destinationId)
		return { deleted: true }
	}),

	test: protectedProcedure.input(destinationIdInput).mutation(async ({ ctx, input }) => {
		requireCapability(ctx.actor.role, "notification.manage")
		const deliveryId = await ctx.destinationController.test(ctx.actor, input.destinationId)
		return { deliveryId }
	}),

	failures: protectedProcedure.query(({ ctx }) => {
		requireCapability(ctx.actor.role, "notification.read")
		return ctx.destinationController.failures(ctx.actor)
	}),

	retry: protectedProcedure.input(deliveryIdInput).mutation(async ({ ctx, input }) => {
		requireCapability(ctx.actor.role, "notification.manage")
		await ctx.destinationController.retry(ctx.actor, input.deliveryId)
		return { queued: true }
	}),

	dismiss: protectedProcedure.input(deliveryIdInput).mutation(async ({ ctx, input }) => {
		requireCapability(ctx.actor.role, "notification.manage")
		await ctx.destinationController.dismiss(ctx.actor, input.deliveryId)
		return { dismissed: true }
	}),

	testResult: protectedProcedure.input(deliveryIdInput).query(({ ctx, input }) => {
		requireCapability(ctx.actor.role, "notification.read")
		return ctx.destinationController.deliveryState(ctx.actor, input.deliveryId)
	}),
})

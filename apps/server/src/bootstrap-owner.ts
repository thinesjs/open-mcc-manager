import type { Db } from "@open-mcc/db"
import { Client } from "pg"
import type { Auth } from "./auth"

const BOOTSTRAP_LOCK_KEY = 415_260_331

export class UsersAlreadyExistError extends Error {}

export type BootstrapOwnerInput = {
	email: string
	password: string
	name: string
	organizationName: string
	organizationSlug: string
}

export type BootstrapOwnerResult = {
	userId: string
	organizationId: string
}

const withBootstrapLock = async <T>(url: string, fn: () => Promise<T>): Promise<T> => {
	const lockClient = new Client({ connectionString: url })
	await lockClient.connect()
	try {
		await lockClient.query("SELECT pg_advisory_lock($1)", [BOOTSTRAP_LOCK_KEY])
		return await fn()
	} finally {
		try {
			await lockClient.query("SELECT pg_advisory_unlock($1)", [BOOTSTRAP_LOCK_KEY])
		} catch {
			console.error("bootstrapOwner: failed to release the bootstrap advisory lock")
		}
		try {
			await lockClient.end()
		} catch {
			console.error("bootstrapOwner: lock client was already disconnected")
		}
	}
}

export const bootstrapOwner = (
	url: string,
	db: Db,
	auth: Auth,
	input: BootstrapOwnerInput,
): Promise<BootstrapOwnerResult> =>
	withBootstrapLock(url, async () => {
		const existingUser = await db.selectFrom("user").select("id").limit(1).executeTakeFirst()
		if (existingUser) {
			throw new UsersAlreadyExistError(
				"Refusing to bootstrap: at least one user already exists in this deployment",
			)
		}

		const signUpResult = await auth.api.signUpEmail({
			body: { email: input.email, password: input.password, name: input.name },
		})

		const organization = await auth.api.createOrganization({
			body: {
				name: input.organizationName,
				slug: input.organizationSlug,
				userId: signUpResult.user.id,
			},
		})
		if (!organization) {
			throw new Error("Failed to create the bootstrap organization")
		}

		return { userId: signUpResult.user.id, organizationId: organization.id }
	})

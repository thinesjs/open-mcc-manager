import type { Db } from "@open-mcc/db"
import type { Auth } from "./auth"

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

export const bootstrapOwner = async (
	db: Db,
	auth: Auth,
	input: BootstrapOwnerInput,
): Promise<BootstrapOwnerResult> => {
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
}

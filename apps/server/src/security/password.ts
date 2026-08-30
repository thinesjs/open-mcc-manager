import argon2 from "argon2"

export const PASSWORD_OPTIONS = {
	type: argon2.argon2id,
	memoryCost: 19456,
	timeCost: 2,
	parallelism: 1,
	hashLength: 32,
} as const

export const hashPassword = (plain: string): Promise<string> => argon2.hash(plain, PASSWORD_OPTIONS)

export const verifyPassword = async (hash: string, plain: string): Promise<boolean> => {
	try {
		return await argon2.verify(hash, plain)
	} catch {
		return false
	}
}

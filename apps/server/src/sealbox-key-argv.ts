import { generateKeyPair } from "@open-mcc/core"

export const GENERATE_KEY_FLAG = "--generate-sealbox-key"

export const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export const KEY_ID_REQUIREMENT =
	"Key id must be 1-64 characters of letters, digits, hyphens and underscores"

export const generateSealboxKey = async (keyId: string): Promise<string> => {
	if (!KEY_ID_PATTERN.test(keyId)) throw new Error(KEY_ID_REQUIREMENT)
	return await generateKeyPair(keyId)
}

export const generateSealboxKeyFromArgv = async (argv: readonly string[]): Promise<string> => {
	const flagAt = argv.indexOf(GENERATE_KEY_FLAG)
	return await generateSealboxKey(argv[flagAt + 1] ?? "k1")
}

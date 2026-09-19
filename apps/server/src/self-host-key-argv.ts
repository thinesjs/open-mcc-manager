import { createSecretStore, generateSshKeyPair } from "@open-mcc/core"

export const SEAL_SELF_HOST_KEY_FLAG = "--seal-self-host-key"

export const DEFAULT_SELF_HOST_KEY_NAME = "this machine"

export const PUBLIC_KEY_FIELD = "SELF_HOST_PUBLIC_KEY"
export const SEALED_PRIVATE_KEY_FIELD = "SELF_HOST_PRIVATE_KEY_SEALED"
export const SEALBOX_KEY_ID_FIELD = "SELF_HOST_PRIVATE_KEY_ID"

export const sealSelfHostKey = async (name: string, sealboxKeys: string): Promise<string> => {
	const secrets = await createSecretStore(sealboxKeys)
	const pair = generateSshKeyPair(name)
	const sealed = secrets.seal(pair.privateKey)
	return [
		`${PUBLIC_KEY_FIELD}=${pair.publicKey.trim()}`,
		`${SEALED_PRIVATE_KEY_FIELD}=${sealed.ciphertext}`,
		`${SEALBOX_KEY_ID_FIELD}=${sealed.keyId}`,
	].join("\n")
}

export const sealSelfHostKeyFromArgv = async (
	argv: readonly string[],
	env: Record<string, string | undefined>,
): Promise<string> => {
	const named = argv[argv.indexOf(SEAL_SELF_HOST_KEY_FLAG) + 1]
	const name = named === undefined || named.startsWith("-") ? DEFAULT_SELF_HOST_KEY_NAME : named
	return await sealSelfHostKey(name, env.SEALBOX_KEYS ?? "")
}

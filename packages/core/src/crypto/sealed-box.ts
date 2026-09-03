import sodium from "libsodium-wrappers-sumo"

type KeyEntry = {
	keyId: string
	publicKey: Uint8Array
	privateKey: Uint8Array
}

export type SealedValue = {
	ciphertext: string
	keyId: string
}

export type SecretStore = {
	activeKeyId: string
	seal: (plaintext: string) => SealedValue
	open: (ciphertext: string, keyId: string) => string
}

export const generateKeyPair = async (keyId: string): Promise<string> => {
	await sodium.ready
	const pair = sodium.crypto_box_keypair()
	const pub = sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL)
	const priv = sodium.to_base64(pair.privateKey, sodium.base64_variants.ORIGINAL)
	return `${keyId}:${pub}:${priv}`
}

const parseEntry = (raw: string): KeyEntry => {
	const parts = raw.split(":")
	const keyId = parts[0]
	const pub = parts[1]
	const priv = parts[2]
	if (parts.length !== 3 || !keyId || !pub || !priv) {
		throw new Error("SEALBOX_KEYS entry must be keyId:publicKey:privateKey")
	}
	return {
		keyId,
		publicKey: sodium.from_base64(pub, sodium.base64_variants.ORIGINAL),
		privateKey: sodium.from_base64(priv, sodium.base64_variants.ORIGINAL),
	}
}

const SELF_TEST_PLAINTEXT = "open-mcc-manager sealed-box self-test"

const verifyKeyPair = (entry: KeyEntry): void => {
	if (entry.publicKey.length !== sodium.crypto_box_PUBLICKEYBYTES) {
		throw new Error(`Key pair '${entry.keyId}' has an invalid public key length`)
	}
	if (entry.privateKey.length !== sodium.crypto_box_SECRETKEYBYTES) {
		throw new Error(`Key pair '${entry.keyId}' has an invalid private key length`)
	}
	try {
		const sealed = sodium.crypto_box_seal(sodium.from_string(SELF_TEST_PLAINTEXT), entry.publicKey)
		const opened = sodium.to_string(
			sodium.crypto_box_seal_open(sealed, entry.publicKey, entry.privateKey),
		)
		if (opened !== SELF_TEST_PLAINTEXT) throw new Error("self-test mismatch")
	} catch {
		throw new Error(`Key pair '${entry.keyId}' failed its seal/open self-test`)
	}
}

export const createSecretStore = async (spec: string): Promise<SecretStore> => {
	await sodium.ready
	const entries = spec
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.map(parseEntry)
	const seenKeyIds = new Set<string>()
	for (const entry of entries) {
		if (seenKeyIds.has(entry.keyId)) {
			throw new Error(`Duplicate keyId '${entry.keyId}' in SEALBOX_KEYS`)
		}
		seenKeyIds.add(entry.keyId)
	}
	for (const entry of entries) {
		verifyKeyPair(entry)
	}

	const active = entries[0]
	if (!active) throw new Error("SEALBOX_KEYS must contain at least one key")
	const byId = new Map(entries.map((e) => [e.keyId, e]))

	return {
		activeKeyId: active.keyId,
		seal: (plaintext) => ({
			ciphertext: sodium.to_base64(
				sodium.crypto_box_seal(sodium.from_string(plaintext), active.publicKey),
				sodium.base64_variants.ORIGINAL,
			),
			keyId: active.keyId,
		}),
		open: (ciphertext, keyId) => {
			const entry = byId.get(keyId)
			if (!entry) throw new Error(`No key available for keyId '${keyId}'`)
			return sodium.to_string(
				sodium.crypto_box_seal_open(
					sodium.from_base64(ciphertext, sodium.base64_variants.ORIGINAL),
					entry.publicKey,
					entry.privateKey,
				),
			)
		},
	}
}

export const KNOWN_INSECURE_KEY_ID = "dev-insecure-publicly-known"

export const usesKnownInsecureKey = (sealboxKeys: string): boolean =>
	sealboxKeys.split(",").some((entry) => entry.trim().startsWith(`${KNOWN_INSECURE_KEY_ID}:`))

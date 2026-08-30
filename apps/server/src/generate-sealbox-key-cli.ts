import { generateKeyPair } from "@open-mcc/core"

const run = async (): Promise<void> => {
	const keyId = process.argv[2] ?? "k1"
	if (!/^[A-Za-z0-9_-]+$/.test(keyId)) {
		throw new Error("Key id must contain only letters, digits, hyphens and underscores")
	}
	const entry = await generateKeyPair(keyId)
	console.error(`Generated sealbox key '${keyId}'. Store it as SEALBOX_KEYS and never commit it.`)
	process.stdout.write(`${entry}\n`)
}

run().catch((error: Error) => {
	console.error(error.message)
	process.exit(1)
})

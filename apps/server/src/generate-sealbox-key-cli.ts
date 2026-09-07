import { generateSealboxKey } from "./sealbox-key-argv"

const run = async (): Promise<void> => {
	const keyId = process.argv[2] ?? "k1"
	const entry = await generateSealboxKey(keyId)
	console.error(`Generated sealbox key '${keyId}'. Store it as SEALBOX_KEYS and never commit it.`)
	process.stdout.write(`${entry}\n`)
}

run().catch((error: Error) => {
	console.error(error.message)
	process.exit(1)
})

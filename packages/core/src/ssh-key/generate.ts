import { generateKeyPairSync } from "node:crypto"
import sshpk from "sshpk"

export type GeneratedSshKeyPair = {
	publicKey: string
	privateKey: string
}

export const generateSshKeyPair = (): GeneratedSshKeyPair => {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	})
	const parsedPublicKey = sshpk.parseKey(publicKey, "pem")
	const parsedPrivateKey = sshpk.parsePrivateKey(privateKey, "pem")
	return {
		publicKey: parsedPublicKey.toString("ssh"),
		privateKey: parsedPrivateKey.toString("ssh-private"),
	}
}

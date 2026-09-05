import { generateKeyPairSync } from "node:crypto"
import sshpk from "sshpk"

export type GeneratedSshKeyPair = {
	publicKey: string
	privateKey: string
}

export const COMMENT_PREFIX = "open-mcc"

export const keyComment = (name: string): string => {
	const safe = name
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
	return safe.length > 0 ? `${COMMENT_PREFIX}:${safe}` : COMMENT_PREFIX
}

export const generateSshKeyPair = (name: string): GeneratedSshKeyPair => {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	})
	const parsedPublicKey = sshpk.parseKey(publicKey, "pem")
	const parsedPrivateKey = sshpk.parsePrivateKey(privateKey, "pem")
	parsedPublicKey.comment = keyComment(name)
	return {
		publicKey: parsedPublicKey.toString("ssh"),
		privateKey: parsedPrivateKey.toString("ssh-private"),
	}
}

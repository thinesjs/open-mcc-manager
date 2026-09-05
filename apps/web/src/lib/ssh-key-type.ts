const TYPES: Record<string, string> = {
	"ssh-ed25519": "ED25519",
	"ssh-rsa": "RSA",
	"ssh-dss": "DSA",
	"ecdsa-sha2-nistp256": "ECDSA",
	"ecdsa-sha2-nistp384": "ECDSA",
	"ecdsa-sha2-nistp521": "ECDSA",
	"sk-ssh-ed25519@openssh.com": "ED25519-SK",
	"sk-ecdsa-sha2-nistp256@openssh.com": "ECDSA-SK",
}

export const keyTypeOf = (publicKey: string): string => {
	const algorithm = publicKey.trim().split(/\s+/)[0] ?? ""
	return TYPES[algorithm] ?? "Unknown"
}

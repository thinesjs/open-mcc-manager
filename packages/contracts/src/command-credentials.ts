const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[
		/^([ \t]*[/!]{0,2}(?:authme[ \t]+(?:register|password)|email[ \t]+setpassword))[ \t]+\S[^\r\n]*/gim,
		"$1 [redacted]",
	],
	[
		/^([ \t]*[/!]{0,2}(?:changepassword|changepass|unregister|register|login|unreg|reg|log|cp|l))[ \t]+\S[^\r\n]*/gim,
		"$1 [redacted]",
	],
]

export const maskCommandCredentials = (command: string): string =>
	PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), command)

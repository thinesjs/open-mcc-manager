const SHELL_WORD = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

export const accountWord = (account: string): string =>
	SHELL_WORD.test(account) ? account : `'${account.replace(/'/g, "'\\''")}'`

export const lingerCommand = (account: string): string =>
	`sudo loginctl enable-linger ${accountWord(account)}`

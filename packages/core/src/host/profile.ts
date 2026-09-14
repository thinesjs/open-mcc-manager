export const INSTANCES_PATH = ".local/share/open-mcc"

export const UNITS_PATH = ".config/systemd/user"

export const INSTANCES_ROOT = `"$HOME"/${INSTANCES_PATH}`

export const UNIT_DIR = `"$HOME"/${UNITS_PATH}`

const HOME_PATTERN = /^\/[A-Za-z0-9._\-/]*$/

export const isUsableHome = (home: string, passwdHome: string): boolean =>
	HOME_PATTERN.test(home) && home === passwdHome

const RUNTIME_DIR_PREFIX = "XDG_RUNTIME_DIR=/run/user/$(id -u) "

export const systemctl = (args: string): string => `${RUNTIME_DIR_PREFIX}systemctl --user ${args}`

export const journalctl = (args: string): string => `${RUNTIME_DIR_PREFIX}journalctl --user ${args}`

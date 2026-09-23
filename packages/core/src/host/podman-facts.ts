import { NETWORK_STACKS, type NetworkStack } from "@open-mcc/contracts"
import { isUsableHome } from "./profile"

export const PODMAN_FLOOR = { major: 4, minor: 3, patch: 1 } as const

const VERSION_LINE = /^podman version ([0-9]+)\.([0-9]+)\.([0-9]+)([-+~][0-9A-Za-z.~+-]*)?$/

export const parsePodmanVersion = (output: string) => {
	const match = VERSION_LINE.exec(output.trim())
	if (match === null) return null
	const [, major = "", minor = "", patch = ""] = match
	return { major: Number(major), minor: Number(minor), patch: Number(patch) }
}

export type PodmanVersion = NonNullable<ReturnType<typeof parsePodmanVersion>>

export const meetsPodmanFloor = ({ major, minor, patch }: PodmanVersion): boolean =>
	major !== PODMAN_FLOOR.major
		? major > PODMAN_FLOOR.major
		: minor !== PODMAN_FLOOR.minor
			? minor > PODMAN_FLOOR.minor
			: patch >= PODMAN_FLOOR.patch

export const formatPodmanVersion = ({ major, minor, patch }: PodmanVersion): string =>
	`${major}.${minor}.${patch}`

export const requiredStackFor = (major: number): NetworkStack =>
	major >= 5 ? "pasta" : "slirp4netns"

export const STORAGE_CONF = '[storage]\ndriver = "overlay"\n'

const STORAGE_CONF_FORMAT = STORAGE_CONF.replaceAll("\n", "\\n")

export const STORAGE_OVERRIDE_VARIABLES = [
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"CONTAINERS_STORAGE_CONF",
] as const

export const STORAGE_OVERRIDES = [...STORAGE_OVERRIDE_VARIABLES, "rootless_storage_path"] as const

export type StorageOverride = (typeof STORAGE_OVERRIDES)[number]

export const SYSTEM_STORAGE_CONF = "/etc/containers/storage.conf"

const singleQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

export const storageOverridesCommand = (systemStorageConf: string): string =>
	[
		...STORAGE_OVERRIDE_VARIABLES.map(
			(name) => `[ -z "\${${name}+set}" ] || printf 'override=${name}\\n'`,
		),
		`! grep -Eqs '^[[:space:]]*rootless_storage_path[[:space:]]*=' ${singleQuote(systemStorageConf)} || printf 'override=rootless_storage_path\\n'`,
	].join("; ")

export const ACCOUNT_STORAGE = ["fresh", "set-up", "used"] as const

export type AccountStorage = (typeof ACCOUNT_STORAGE)[number]

const CONF_PATH = '"$HOME"/.config/containers/storage.conf'

const GRAPH_ROOT = '"$HOME"/.local/share/containers/storage'

export const STORAGE_STATE_COMMAND = [
	`if printf '${STORAGE_CONF_FORMAT}' | cmp -s - ${CONF_PATH}; then printf 'storage=set-up\\n'`,
	`elif [ ! -e ${CONF_PATH} ] && [ ! -L ${CONF_PATH} ] && { { [ ! -e ${GRAPH_ROOT} ] && [ ! -L ${GRAPH_ROOT} ]; } || { [ -d ${GRAPH_ROOT} ] && [ -r ${GRAPH_ROOT} ] && [ -z "$(ls -A ${GRAPH_ROOT})" ]; }; }; then printf 'storage=fresh\\n'`,
	"else printf 'storage=used\\n'; fi",
].join("; ")

export const PODMAN_INFO_COMMAND =
	"podman info --format '{{.Host.Security.Rootless}} {{.Store.GraphDriverName}}'"

const PODMAN_INFO_LINE = /^(true|false) ([A-Za-z0-9_-]{1,32})$/

export const parsePodmanInfo = (output: string) => {
	const match = PODMAN_INFO_LINE.exec(output.trim())
	if (match === null) return { rootless: null, driver: null }
	const [, rootless = "", driver = ""] = match
	return { rootless: rootless === "true", driver }
}

export const STORAGE_STEP_WORDS = ["refused", "used", "root"] as const

export type StorageStepWord = (typeof STORAGE_STEP_WORDS)[number]

export const storageStepWord = (output: string): StorageStepWord | null =>
	STORAGE_STEP_WORDS.find((word) => word === output.trim()) ?? null

export const storageStepCommand = (): string =>
	[
		`overrides=$(${storageOverridesCommand(SYSTEM_STORAGE_CONF)})`,
		`if [ -n "$overrides" ]; then printf 'refused\\n'; exit 1; fi`,
		`state=$(${STORAGE_STATE_COMMAND})`,
		"ours=0; kept=0",
		`undo() { [ "$ours" = 1 ] || return 0; rm -f ${CONF_PATH}; if [ "$kept" = 1 ]; then rm -rf ${GRAPH_ROOT}/..?* ${GRAPH_ROOT}/.[!.]* ${GRAPH_ROOT}/*; else rm -rf ${GRAPH_ROOT}; fi; }`,
		`if [ "$state" = storage=fresh ]; then dir="$HOME"/.config/containers; [ ! -d ${GRAPH_ROOT} ] || kept=1; mkdir -p "$dir" || exit 1; tmp=$(mktemp "$dir"/.storage.conf.XXXXXX) || exit 1; if ! printf '${STORAGE_CONF_FORMAT}' > "$tmp" || ! mv -f "$tmp" ${CONF_PATH}; then rm -f "$tmp"; exit 1; fi; ours=1; fi`,
		`if ! info=$(${PODMAN_INFO_COMMAND}); then undo; [ "$state" != storage=used ] || printf 'used\\n'; exit 1; fi`,
		`case "$info" in "true overlay") printf 'ready\\n' ;; "true "*) undo; printf 'used\\n'; exit 1 ;; *) undo; printf 'root\\n'; exit 1 ;; esac`,
	].join("\n")

const fact = (key: string, command: string): string =>
	`printf '${key}=%s\\n' "$( ${command} 2>/dev/null | head -n 1 | cut -c 1-256 | tr -c '[:print:]\\n' ' ')"`

const subordinateLines = (key: string, file: string): string =>
	`awk -F: -v u="$(id -un 2>/dev/null)" -v i="$(id -u 2>/dev/null)" 'NF == 3 && $1 != "" && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ { if ($1 == u || $1 == i) own = 1; e = $2 + $3; if (e > top) top = e } END { printf "${key}=%s\\n${key}-end=%.0f\\n", (own ? "own" : "other"), top }' ${file} 2>/dev/null`

export const OVERLAY_HELPER = "fuse-overlayfs"

export const HOST_FACTS_COMMAND = [
	fact("uid", "id -u"),
	`printf 'home=%s\\n' "$(printf '%s' "$HOME" | tr -c '[:print:]' ' ' | cut -c 1-256)"`,
	fact("passwd-home", 'getent passwd "$(id -un)" | cut -d: -f6'),
	fact("os", `(. /etc/os-release; printf '%s %s\\n' "\${ID:-}" "\${VERSION_ID:-}")`),
	fact("podman", "podman --version"),
	STORAGE_STATE_COMMAND,
	storageOverridesCommand(SYSTEM_STORAGE_CONF),
	subordinateLines("subuid", "/etc/subuid"),
	subordinateLines("subgid", "/etc/subgid"),
	fact("cgroup", "stat -fc %T /sys/fs/cgroup"),
	...NETWORK_STACKS.map(
		(stack) => `! command -v ${stack} >/dev/null 2>&1 || printf 'helper=${stack}\\n'`,
	),
	`! command -v ${OVERLAY_HELPER} >/dev/null 2>&1 || printf 'overlay-helper=${OVERLAY_HELPER}\\n'`,
	`if command -v curl >/dev/null 2>&1; then ${fact("metadata", "curl -s --max-time 1 -o /dev/null -w '%{http_code}' http://169.254.169.254/")}; else printf 'metadata=none\\n'; fi`,
	"exit 0",
].join("\n")

export const METADATA_REACH = ["unanswered", "answered", "unchecked"] as const

const UID = /^[0-9]{1,10}$/

const OS_WORD = /^[a-z0-9._-]{1,32}$/

const SUBORDINATE_END = /^[0-9]{1,10}$/

export const parseHostFacts = (output: string) => {
	const lines = output.split("\n").map((line) => {
		const at = line.indexOf("=")
		return at < 0 ? { key: "", value: "" } : { key: line.slice(0, at), value: line.slice(at + 1) }
	})
	const all = (key: string): string[] =>
		lines.filter((line) => line.key === key).map((line) => line.value)
	const first = (key: string): string | null => all(key)[0] ?? null

	const uid = (first("uid") ?? "").trim()
	const [osId = "", osVersion = ""] = (first("os") ?? "").trim().split(" ")
	const subordinate = (key: string) => {
		const end = (first(`${key}-end`) ?? "").trim()
		return {
			own: (first(key) ?? "").trim() === "own",
			end: SUBORDINATE_END.test(end) ? Number(end) : 0,
		}
	}
	const metadata = (first("metadata") ?? "none").trim()

	return {
		uid: UID.test(uid) ? Number(uid) : null,
		usableHome: isUsableHome(first("home") ?? "", first("passwd-home") ?? ""),
		os: {
			id: OS_WORD.test(osId) ? osId : null,
			version: OS_WORD.test(osVersion) ? osVersion : null,
		},
		podman: parsePodmanVersion(first("podman") ?? ""),
		storage: ACCOUNT_STORAGE.find((state) => state === first("storage")?.trim()) ?? "used",
		overrides: STORAGE_OVERRIDES.filter((name) =>
			all("override").some((value) => value.trim() === name),
		),
		subuid: subordinate("subuid"),
		subgid: subordinate("subgid"),
		cgroupV2: (first("cgroup") ?? "").trim() === "cgroup2fs",
		helpers: NETWORK_STACKS.filter((stack) =>
			all("helper").some((value) => value.trim() === stack),
		),
		overlayHelper: all("overlay-helper").some((value) => value.trim() === OVERLAY_HELPER),
		metadata:
			metadata === "none"
				? METADATA_REACH[2]
				: metadata === "000"
					? METADATA_REACH[0]
					: METADATA_REACH[1],
	}
}

export type HostPodmanFacts = ReturnType<typeof parseHostFacts>

export const SUBORDINATE_ID_FLOOR = 100_000

export const SUBORDINATE_ID_COUNT = 65_536

export const nextSubordinateRange = (subuidEnd: number, subgidEnd: number) => {
	const start = Math.max(SUBORDINATE_ID_FLOOR, subuidEnd, subgidEnd)
	return { start, end: start + SUBORDINATE_ID_COUNT - 1 }
}

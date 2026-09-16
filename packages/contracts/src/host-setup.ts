const singleQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

export const SCRIPT_HEREDOC = "OPENMCC_SETUP"

export const KEY_HEREDOC = "OPENMCC_KEY"

export const SCAN_HEREDOC = "OPENMCC_AUTHKEY_SCAN"

export const fingerprintCommand = (): string =>
	"ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}'"

export const setupSummary = (
	username: string,
	keyName: string,
	createAccount: boolean,
): readonly string[] => [
	...(createAccount ? [`Creates the account ${username} if it is missing`] : []),
	`Offers to unlock ${username} if it is locked`,
	`Authorises the key ${keyName} for ${username}`,
	"Enables lingering, so instances keep running after you log out",
	"Checks this machine has a client build",
	"Installs Podman if it is missing",
	`Lets ${username} run containers`,
	"Prints the host key fingerprint for the next step",
]

export const ACCOUNT_NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/

export const ACCOUNT_NAME_REQUIREMENT =
	"Use lowercase letters, digits, - and _, starting with a letter or _."

const createAccountCommand = (username: string): string =>
	`useradd --create-home --shell /bin/sh --password '*' -- ${singleQuote(username)}`

const createSection = (username: string): string => `
if [ -z "$home" ]; then
  if ! made=$(${createAccountCommand(username)} 2>&1); then
    printf '%s\\n' "$made" | tr -d '\\000-\\010\\013-\\037\\177' >&2
    echo "Could not create an account called $account on this host." >&2
    exit 1
  fi
  home=$(getent passwd "$account" | cut -d: -f6 || true)
  if [ -z "$home" ]; then
    echo "Created $account but this host reports no home folder for it." >&2
    exit 1
  fi
  echo "  account $account created"
else
  echo "  account $account already exists, left alone"
fi
`

const missingSection = (username: string): string => `
if [ -z "$home" ]; then
  echo "There is no account called $account on this host." >&2
  echo ${singleQuote('Either go back to the Account step and choose "Create it for me",')} >&2
  echo ${singleQuote(`or run this first: sudo ${createAccountCommand(username)}`)} >&2
  exit 1
fi
`

const clearPasswordCommand = (username: string): string =>
	`usermod -p '*' -- ${singleQuote(username)}`

const restorePasswordCommand = (username: string): string =>
	`usermod -U -- ${singleQuote(username)}`

const shellCommand = (username: string): string => `chsh -s /bin/sh -- ${singleQuote(username)}`

export const LOCK_STATE_FUNCTION = `lock_state() {
  case "$1" in
    '!'|'!!'|'!*') printf none ;;
    '!'*) printf password ;;
    *) printf open ;;
  esac
}`

export const UNLOCK_MODES = ["ask", "grant"] as const

export type UnlockMode = (typeof UNLOCK_MODES)[number]

export const SETUP_PRIVILEGES = ["sudo", "none"] as const

export type SetupPrivilege = (typeof SETUP_PRIVILEGES)[number]

export const lockedNotice = (username: string): string =>
	`The account ${username} is locked, so the server may refuse it even with the right key.`

export const LOCKED_KEEPS_PASSWORD =
	"It has a password. Unlocking puts that password back exactly as it was, and changes nothing else."

export const LOCKED_HAS_NO_PASSWORD =
	"It has no password, and unlocking gives it none. It stays key-only."

const askSection = (): string => `  printf 'Unlock %s now? [y/N] ' "$account" >&2
  answer=n
  if { read -r reply < /dev/tty; } 2>/dev/null; then answer=$reply; fi`

const grantSection = (): string => `  answer=y`

const READ_STATE = `lock_state "$(getent shadow "$account" 2>/dev/null | cut -d: -f2 || true)"`

const lockSection = (username: string, unlock: UnlockMode): string => `
${LOCK_STATE_FUNCTION}
state=$(${READ_STATE})
if [ "$state" != open ]; then
  echo ${singleQuote(lockedNotice(username))} >&2
  if [ "$state" = password ]; then
    echo ${singleQuote(LOCKED_KEEPS_PASSWORD)} >&2
  else
    echo ${singleQuote(LOCKED_HAS_NO_PASSWORD)} >&2
  fi
${unlock === "grant" ? grantSection() : askSection()}
  case "$answer" in
    y|Y|yes|Yes|YES)
      if [ "$state" = password ]; then
        ${restorePasswordCommand(username)} || true
      else
        ${clearPasswordCommand(username)} || true
      fi
      if [ "$(${READ_STATE})" != open ]; then
        echo "Could not unlock $account." >&2
        exit 1
      fi
      echo "  $account unlocked"
      ;;
    *)
      echo "Left $account locked, and changed nothing." >&2
      if [ "$state" = password ]; then
        echo ${singleQuote(`Unlock it yourself, then run this again: sudo ${restorePasswordCommand(username)}`)} >&2
      else
        echo ${singleQuote(`Unlock it yourself, then run this again: sudo ${clearPasswordCommand(username)}`)} >&2
      fi
      exit 1
      ;;
  esac
fi
`

const signInSection = (username: string): string => `
shell=$(getent passwd "$account" | cut -d: -f7)
case "$shell" in
  */nologin|*/false)
    echo "The account $account cannot run anything: its shell is $shell." >&2
    echo ${singleQuote(`Give it a login shell, then run this again: sudo ${shellCommand(username)}`)} >&2
    exit 1 ;;
esac
if [ ! -d "$home" ]; then
  echo "The account $account has no home folder at $home, so nothing can be stored for it." >&2
  exit 1
fi
state=$(${READ_STATE})
if [ "$state" != open ]; then
  echo "The account $account is locked, so a key login can still be refused." >&2
  if [ "$state" = password ]; then
    echo ${singleQuote(`Unlock it, then run this again: sudo ${restorePasswordCommand(username)}`)} >&2
  else
    echo ${singleQuote(`Unlock it, then run this again: sudo ${clearPasswordCommand(username)}`)} >&2
  fi
  exit 1
fi
echo "  nothing on $account blocks a key login"
`

const ROOT_SECTION = `
if [ "$(id -u "$account")" = 0 ]; then
  echo "Bots can't run as root. Use a normal account." >&2
  exit 1
fi
`

const LINGER_SECTION = `
if ! loginctl enable-linger "$account"; then
  echo "Could not enable lingering for $account. Instances would stop when its last session ends." >&2
  exit 1
fi
echo "  lingering enabled, so instances keep running after logout"
`

const PODMAN_SECTION = `
if command -v podman >/dev/null 2>&1; then
  echo "  Podman already installed"
elif command -v apt-get >/dev/null 2>&1; then
  log=$(mktemp)
  if ! DEBIAN_FRONTEND=noninteractive apt-get update -qq >"$log" 2>&1; then
    echo "Could not refresh the package lists:" >&2; tail -5 "$log" >&2; rm -f "$log"; exit 1
  fi
  major=$(apt-cache policy podman | awk '/Candidate:/ {print $2; exit}' | sed -E 's/^[0-9]+://; s/[^0-9].*$//')
  if [ -z "$major" ]; then
    echo "This distribution has no Podman package." >&2; rm -f "$log"; exit 1
  fi
  helper=slirp4netns; [ "$major" -ge 5 ] && helper=passt
  if ! DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o Dpkg::Use-Pty=0 --no-install-recommends --no-remove podman uidmap "$helper" catatonit dbus-user-session >"$log" 2>&1; then
    echo "Could not install Podman:" >&2; tail -5 "$log" >&2; rm -f "$log"; exit 1
  fi
  rm -f "$log"
  echo "  installed Podman with $helper"
else
  echo "This distribution isn't supported yet." >&2
  exit 1
fi
`

const SUBORDINATE_SECTION = `
uid=$(id -u "$account")
has_range() {
  awk -F: -v a="$account" -v i="$uid" '$1 == a || $1 == i { found = 1 } END { exit !found }' "$1" 2>/dev/null
}
if has_range /etc/subuid && has_range /etc/subgid; then
  echo "  $account can already run containers"
else
  start=$(cat /etc/subuid /etc/subgid 2>/dev/null | awk -F: 'NF == 3 && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ { end = $2 + $3; if (end > top) top = end } END { printf "%d\\n", (top > 100000 ? top : 100000) }')
  range="$start-$((start + 65535))"
  has_range /etc/subuid || usermod --add-subuids "$range" "$account"
  has_range /etc/subgid || usermod --add-subgids "$range" "$account"
  echo "  $account can now run containers"
fi
`

const AUTHORISE = `set -eu
umask 077
key=$(cat)
home=$(getent passwd "$(id -un)" | cut -d: -f6)
mkdir -p "$home/.ssh"
chmod 700 "$home/.ssh"
touch "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"
material=$(printf "%s" "$key" | awk "{print \\$2}")
scan=$(mktemp)
cat <<"${SCAN_HEREDOC}" > "$scan"
function is_keytype(s) { return s ~ /^(ssh-|ecdsa-|sk-)/ }
BEGIN { if (blob == "") exit }
/^[ \\t]*#/ { next }
/^[ \\t]*$/ { next }
decided { next }
{
	n = split($0, f, /[ \\t]+/)
	k = 0
	for (i = 1; i <= n; i++) {
		if (is_keytype(f[i])) { k = i; break }
	}
	if (k == 0 || f[k + 1] != blob) next
	decided = 1
	present = 1
	dangerous = 0
	for (i = 1; i < k; i++) {
		if (index(f[i], "\\"") > 0 || index(f[i], "=") > 0) dangerous = 1
	}
	is_clean = 0
	if (k == 1) {
		is_clean = 1
	} else if (!dangerous) {
		opts = f[1]
		for (i = 2; i < k; i++) opts = opts "," f[i]
		nopt = split(opts, tokens, ",")
		ok = 1
		has_restrict = 0
		has_portfwd = 0
		for (i = 1; i <= nopt; i++) {
			t = tokens[i]
			if (t == "restrict") { has_restrict = 1 }
			else if (t == "port-forwarding") { has_portfwd = 1 }
			else if (t == "pty" || t == "no-pty" || t == "agent-forwarding" || t == "no-agent-forwarding" || t == "X11-forwarding" || t == "no-X11-forwarding" || t == "user-rc" || t == "no-user-rc") { }
			else { ok = 0 }
		}
		if (ok && (!has_restrict || has_portfwd)) is_clean = 1
	}
	if (is_clean) clean = 1
	else badline = NR
}
END { printf "%d %d %d", present + 0, clean + 0, badline + 0 }
${SCAN_HEREDOC}
info=$(awk -v blob="$material" -f "$scan" "$home/.ssh/authorized_keys")
rm -f "$scan"
set -- $info
present=\${1:-0}
clean=\${2:-0}
badline=\${3:-0}
if [ "$present" = "1" ] && [ "$clean" = "1" ]; then
  echo "  key already present, left alone"
elif [ "$present" = "1" ]; then
  echo "This key is already authorised in authorized_keys, but line $badline restricts it in a way that would block the manager. Edit or remove that line, then run this setup again." >&2
  exit 1
else
  if [ -s "$home/.ssh/authorized_keys" ] && [ -n "$(tail -c 1 "$home/.ssh/authorized_keys")" ]; then
    printf "\\n" >> "$home/.ssh/authorized_keys"
  fi
  printf "%s\\n" "$key" >> "$home/.ssh/authorized_keys"
  echo "  key added to $home/.ssh/authorized_keys"
fi`

export const hostSetupScript = (
	username: string,
	publicKey: string,
	createAccount: boolean,
	unlock: UnlockMode = "ask",
	privilege: SetupPrivilege = "sudo",
): string => `${privilege === "sudo" ? "sudo " : ""}sh -s <<'${SCRIPT_HEREDOC}'
set -eu

account=${singleQuote(username)}

key=$(cat <<'${KEY_HEREDOC}'
${publicKey}
${KEY_HEREDOC}
)

home=$(getent passwd "$account" | cut -d: -f6 || true)
${createAccount ? createSection(username) : missingSection(username)}${ROOT_SECTION}${lockSection(username, unlock)}
authorise='${AUTHORISE}'
if ! said=$(printf '%s\\n' "$key" | setsid su -s /bin/sh "$account" -c "$authorise" 2>&1); then
  printf '%s\\n' "$said" | tr -d '\\000-\\010\\013-\\037\\177' >&2
  echo "Could not authorise the key for $account." >&2
  exit 1
fi
printf '%s\\n' "$said" | tr -d '\\000-\\010\\013-\\037\\177'
${LINGER_SECTION}
machine=$(uname -m)
case "$machine" in
  x86_64|amd64|aarch64|arm64) echo "  architecture $machine is supported" ;;
  *) echo "There is no client build for $machine. This host cannot run instances." >&2; exit 1 ;;
esac
${PODMAN_SECTION}${SUBORDINATE_SECTION}${signInSection(username)}
echo
echo "Host key fingerprint - paste this into the dashboard:"
${fingerprintCommand()}
${SCRIPT_HEREDOC}`

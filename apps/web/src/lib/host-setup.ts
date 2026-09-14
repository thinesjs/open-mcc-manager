import type { HostMode } from "@open-mcc/contracts"

const singleQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

export const SCRIPT_HEREDOC = "OPENMCC_SETUP"

export const KEY_HEREDOC = "OPENMCC_KEY"

export const fingerprintCommand = (): string =>
	"ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}'"

export const setupSummary = (mode: HostMode, username: string): readonly string[] => [
	`Authorises this deployment's key for ${username}`,
	...(mode === "rootless"
		? ["Enables lingering, so instances keep running after you log out"]
		: []),
	"Checks this machine has a client build",
	"Installs libicu, which the client needs, if it is missing",
	"Prints the host key fingerprint for the next step",
]

export const requiresRootAccount = (mode: HostMode, username: string): boolean =>
	mode === "system" && username !== "root"

const rootCheck = (mode: HostMode): string =>
	mode === "system"
		? `
if [ "$account" != "root" ]; then
  echo "This host was set up to use root, but $account is not root. Enroll it without root instead." >&2
  exit 1
fi
`
		: ""

const lingerSection = (mode: HostMode): string =>
	mode === "rootless"
		? `
if ! loginctl enable-linger "$account"; then
  echo "Could not enable lingering for $account. Instances would stop when its last session ends." >&2
  exit 1
fi
echo "  lingering enabled, so instances keep running after logout"
`
		: ""

const AUTHORISE = `set -eu
umask 077
key=$(cat)
home=$(getent passwd "$(id -un)" | cut -d: -f6)
mkdir -p "$home/.ssh"
chmod 700 "$home/.ssh"
touch "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"
material=$(printf "%s" "$key" | awk "{print \\$2}")
if [ -n "$material" ] && grep -qF -- "$material" "$home/.ssh/authorized_keys"; then
  echo "  key already present, left alone"
else
  if [ -s "$home/.ssh/authorized_keys" ] && [ -n "$(tail -c 1 "$home/.ssh/authorized_keys")" ]; then
    printf "\\n" >> "$home/.ssh/authorized_keys"
  fi
  printf "%s\\n" "$key" >> "$home/.ssh/authorized_keys"
  echo "  key added to $home/.ssh/authorized_keys"
fi`

export const hostSetupScript = (
	mode: HostMode,
	username: string,
	publicKey: string,
): string => `sudo sh -s <<'${SCRIPT_HEREDOC}'
set -eu

account=${singleQuote(username)}

key=$(cat <<'${KEY_HEREDOC}'
${publicKey}
${KEY_HEREDOC}
)

home=$(getent passwd "$account" | cut -d: -f6 || true)
if [ -z "$home" ]; then
  echo "There is no account called $account on this host." >&2
  exit 1
fi
${rootCheck(mode)}
authorise='${AUTHORISE}'
if ! printf '%s\\n' "$key" | setsid su -s /bin/sh "$account" -c "$authorise"; then
  echo "Could not authorise the key for $account." >&2
  exit 1
fi
${lingerSection(mode)}
machine=$(uname -m)
case "$machine" in
  x86_64|amd64|aarch64|arm64) echo "  architecture $machine is supported" ;;
  *) echo "There is no client build for $machine. This host cannot run instances." >&2; exit 1 ;;
esac

if ldconfig -p 2>/dev/null | grep -q libicuuc; then
  echo "  libicu already installed"
elif command -v apt-get >/dev/null 2>&1; then
  log=$(mktemp)
  if ! DEBIAN_FRONTEND=noninteractive apt-get update -qq >"$log" 2>&1; then
    echo "Could not refresh the package lists:" >&2; tail -5 "$log" >&2; exit 1
  fi
  pkg=$(apt-cache --names-only search '^libicu[0-9]+$' | awk '{print $1}' | sort -V | tail -1)
  pkg=\${pkg:-libicu-dev}
  if ! DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o Dpkg::Use-Pty=0 "$pkg" >"$log" 2>&1; then
    echo "Could not install $pkg:" >&2; tail -5 "$log" >&2; exit 1
  fi
  rm -f "$log"
  echo "  installed $pkg"
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y -q libicu >/dev/null && echo "  installed libicu"
elif command -v apk >/dev/null 2>&1; then
  apk add --quiet icu-libs && echo "  installed icu-libs"
else
  echo "Install the libicu package for this distribution, then run this again." >&2
  exit 1
fi

echo
echo "Host key fingerprint - paste this into the dashboard:"
${fingerprintCommand()}
${SCRIPT_HEREDOC}`

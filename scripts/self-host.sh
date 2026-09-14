#!/usr/bin/env sh
set -eu

# Prepares the machine this runs on to be managed by the control plane that also
# runs on it, so a single host is enough.
#
# It mints a key, adds a restricted entry for it to the invoking user's own
# authorized_keys, and then proves — from inside a container built from the
# control plane's own image — which address actually reaches this machine's
# sshd. That last part cannot be assumed: inside a container "localhost" is the
# container, and the address that works differs by container runtime. Guessing
# it wrong shows up as a network fault rather than a configuration one.
#
# Nothing here needs root, and it will not run as root. Instances run under the
# invoking user's own systemd, so what this key can reach is that one account.
#
#   sh scripts/self-host.sh                      mint a key and install it
#   sh scripts/self-host.sh --public-key key.pub install a key the control plane made
#   sh scripts/self-host.sh --port 2222          sshd is not on 22
#
# Running it twice changes nothing. It never overwrites a key or an existing
# authorized_keys line. It either finishes, or exits non-zero having taken back
# everything it wrote.

SSH_PORT="${OPEN_MCC_SSH_PORT:-22}"
KEY_PATH="${OPEN_MCC_SELF_HOST_KEY:-${HOME:-}/.ssh/open-mcc-self-host}"
MATERIALS="${OPEN_MCC_SELF_HOST_ENV:-.env.self-host}"
PROJECT="${COMPOSE_PROJECT_NAME:-open-mcc}"
TIMEOUT_MS="${OPEN_MCC_SELF_HOST_TIMEOUT_MS:-8000}"
KEY_COMMENT="open-mcc:self-host"
SUPPLIED=""

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but was not found on PATH"; }

while [ $# -gt 0 ]; do
	case "$1" in
		--public-key)
			[ $# -ge 2 ] || die "--public-key needs a file, or - to read one from stdin"
			SUPPLIED="$2"
			shift 2
			;;
		--port)
			[ $# -ge 2 ] || die "--port needs a port number"
			SSH_PORT="$2"
			shift 2
			;;
		-h | --help)
			awk 'NR < 4 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"
			exit 0
			;;
		*) die "unknown argument: $1" ;;
	esac
done

case "$SSH_PORT" in
	'' | *[!0-9]*) die "port must be a number, got '$SSH_PORT'" ;;
esac

# Run as root, the key would land in root's authorized_keys behind a command that
# runs whatever the control plane sends, while everything here calls it rootless.
[ "$(id -u)" != "0" ] || die "run this as the account instances should run under, not as root"

need ssh
need ssh-keygen
need ssh-keyscan

[ -n "${HOME:-}" ] || die "HOME is not set, so there is no authorized_keys to add to"
case "$HOME" in
	*[\"\'\\]*) die "HOME contains a quote or a backslash, which an authorized_keys option cannot carry" ;;
esac

ACCOUNT="$(id -un)"
MACHINE="$(uname -n 2>/dev/null | cut -d. -f1 | cut -c1-64)"
[ -n "$MACHINE" ] || MACHINE="this machine"
SSH_DIR="$HOME/.ssh"
AUTHORIZED="$SSH_DIR/authorized_keys"
AUTHORIZED_BEFORE="$SSH_DIR/.authorized_keys.before-open-mcc"
AUTHORIZED_AFTER="$SSH_DIR/.authorized_keys.after-open-mcc"
WRAPPER="$SSH_DIR/open-mcc-self-host-command"

umask 077

# Everything this run writes is recorded as it is written, and taken back if the
# run stops before the end. authorized_keys is only put back whole when nothing
# else changed it meanwhile; otherwise only this run's own entry comes out.

WROTE_SSH_DIR="no"
WROTE_KEY="no"
WROTE_WRAPPER="no"
WROTE_AUTHORIZED="no"
KEPT_AUTHORIZED="no"
FINISHED="no"

take_back() {
	trap '' HUP INT TERM
	[ "$FINISHED" = "no" ] || return 0
	if [ "$KEPT_AUTHORIZED" = "yes" ] || [ "$WROTE_AUTHORIZED" = "yes" ]; then
		if [ ! -f "$AUTHORIZED_AFTER" ] || cmp -s "$AUTHORIZED" "$AUTHORIZED_AFTER"; then
			if [ "$KEPT_AUTHORIZED" = "yes" ]; then
				cat "$AUTHORIZED_BEFORE" > "$AUTHORIZED"
			else
				rm -f "$AUTHORIZED"
			fi
		else
			FILTERED=0
			grep -vxF -- "$ENTRY" "$AUTHORIZED" > "$AUTHORIZED_AFTER" || FILTERED=$?
			if [ "$FILTERED" -le 1 ]; then
				cat "$AUTHORIZED_AFTER" > "$AUTHORIZED"
				warn "authorized_keys changed while this ran, so only the entry this run added was taken out of it"
			else
				warn "authorized_keys changed while this ran and could not be read back. Remove this line from it by hand:
         $ENTRY"
			fi
		fi
		rm -f "$AUTHORIZED_BEFORE" "$AUTHORIZED_AFTER"
	fi
	if [ "$WROTE_WRAPPER" = "yes" ]; then rm -f "$WRAPPER"; fi
	if [ "$WROTE_KEY" = "yes" ]; then rm -f "$KEY_PATH" "$KEY_PATH.pub"; fi
	if [ "$WROTE_SSH_DIR" = "yes" ]; then rmdir "$SSH_DIR" 2>/dev/null || true; fi
}

trap take_back EXIT
trap 'exit 1' HUP INT TERM

make_ssh_dir() {
	[ ! -d "$SSH_DIR" ] || return 0
	mkdir -p "$SSH_DIR"
	WROTE_SSH_DIR="yes"
}

# 1. Does anything answer ssh on this machine, and what does it call itself?

HOST_KEYS="$(ssh-keyscan -T 5 -p "$SSH_PORT" 127.0.0.1 2>/dev/null | grep -v '^#' || true)"
[ -n "$HOST_KEYS" ] || die "nothing answered ssh on 127.0.0.1:$SSH_PORT.
       Start it (Debian and Ubuntu: 'sudo systemctl enable --now ssh'; RHEL and Fedora:
       'sudo systemctl enable --now sshd'; macOS: System Settings, General, Sharing,
       Remote Login), or pass --port if sshd listens somewhere else."

FINGERPRINTS="$(printf '%s\n' "$HOST_KEYS" | ssh-keygen -lf - 2>/dev/null | awk '{print $2}' | sort -u)"
[ -n "$FINGERPRINTS" ] || die "could not read a fingerprint from the host keys on 127.0.0.1:$SSH_PORT"
FINGERPRINT_LIST="$(printf '%s\n' "$FINGERPRINTS" | tr '\n' ',' | sed 's/,$//')"

say "sshd answers on 127.0.0.1:$SSH_PORT and offers $(printf '%s\n' "$FINGERPRINTS" | wc -l | tr -d ' ') host key(s)"

# 2. The key. A supplied one is installed as given; otherwise mint a fresh one.
#    An existing private key is never overwritten, moved or re-used for this.

PUBLIC_KEY=""
PRIVATE_KEY_PATH=""

if [ -n "$SUPPLIED" ]; then
	if [ "$SUPPLIED" = "-" ]; then
		PUBLIC_KEY="$(cat)"
	else
		[ -f "$SUPPLIED" ] || die "no such public key file: $SUPPLIED"
		PUBLIC_KEY="$(cat "$SUPPLIED")"
	fi
	printf '%s\n' "$PUBLIC_KEY" | ssh-keygen -lf - >/dev/null 2>&1 ||
		die "that does not read as an ssh public key"
	say "Installing the public key you supplied; the control plane already holds its private half"
elif [ -f "$KEY_PATH" ]; then
	[ -f "$KEY_PATH.pub" ] ||
		die "$KEY_PATH exists but $KEY_PATH.pub does not.
       Refusing to touch the private key. Restore the .pub beside it, or point
       OPEN_MCC_SELF_HOST_KEY at a path that is free."
	PUBLIC_KEY="$(cat "$KEY_PATH.pub")"
	PRIVATE_KEY_PATH="$KEY_PATH"
	say "Reusing the self-host key already at $KEY_PATH"
elif [ -e "$KEY_PATH.pub" ]; then
	die "$KEY_PATH.pub exists but $KEY_PATH does not.
       Refusing to overwrite it. Move it aside, or point OPEN_MCC_SELF_HOST_KEY at a
       path that is free."
else
	make_ssh_dir
	WROTE_KEY="yes"
	ssh-keygen -q -t ed25519 -N '' -C "$KEY_COMMENT" -f "$KEY_PATH" </dev/null ||
		die "could not create a key at $KEY_PATH"
	PUBLIC_KEY="$(cat "$KEY_PATH.pub")"
	PRIVATE_KEY_PATH="$KEY_PATH"
	say "Minted a new ed25519 key at $KEY_PATH"
fi

# One key, on one line. ssh-keygen reads every key it is given, but only the
# first would carry the restrictions below; any other would be appended as a key
# of its own, with none.

KEY_LINES="$(printf '%s\n' "$PUBLIC_KEY" | awk 'NF' | wc -l | tr -d ' ')"
[ "$KEY_LINES" = "1" ] || die "that holds $KEY_LINES keys. Pass exactly one public key, on one line."
PUBLIC_KEY="$(printf '%s\n' "$PUBLIC_KEY" | awk 'NF')"

KEY_BLOB="$(printf '%s\n' "$PUBLIC_KEY" | awk 'NF { print $2; exit }')"
[ -n "$KEY_BLOB" ] || die "could not read the key material out of the public key"

# 3. What authorized_keys already says about this key. Listed under any other
#    options, it is not an entry this script can vouch for, so it stops rather
#    than report restrictions that are not there. A commented-out line is not an
#    entry, and a check that could not finish is not a clean one.

OPTIONS="restrict,port-forwarding,permitopen=\"127.0.0.1:*\",command=\"'$WRAPPER'\""
ENTRY="$OPTIONS $PUBLIC_KEY"
LISTED="no"

if [ -f "$AUTHORIZED" ]; then
	COUNTS="$(awk -v blob="$KEY_BLOB" -v prefix="$OPTIONS " '
		/^[ \t]*#/ { next }
		index($0, blob) { if (index($0, prefix) == 1) restricted++; else unrestricted++ }
		END { printf "%d %d\n", restricted, unrestricted }
	' "$AUTHORIZED")" || die "could not check what $AUTHORIZED already says about this key, so nothing was changed"
	[ "${COUNTS#* }" = "0" ] || die "authorized_keys already carries this key without these restrictions, so nothing was changed.
       To use them, replace every line carrying it by hand with:
       $ENTRY"
	[ "${COUNTS% *}" = "0" ] || LISTED="yes"
fi

# 4. The forced command. It pins this key to one job and to /bin/sh, and denies
#    it an interactive session. It cannot bound *which* commands run: the
#    control plane composes shell pipelines at runtime, so there is no closed
#    set to allow. See the note this writes into the file.

if [ ! -f "$WRAPPER" ]; then
	make_ssh_dir
	WROTE_WRAPPER="yes"
	cat > "$WRAPPER" <<'WRAPPER_EOF'
#!/usr/bin/env sh
# Forced command for the open-mcc-manager self-host key. Written by
# scripts/self-host.sh; delete the matching authorized_keys line to revoke it.
#
# This runs what the control plane asks for, under /bin/sh whatever login shell
# the account has, and refuses a request that names no command. It deliberately
# does not filter commands: the control plane builds pipelines at runtime, so an
# allowlist tight enough to be worth having would break provisioning, and one
# loose enough to work would be a shell parser guarding a shell. The bound on
# this key is the unprivileged account it lands in, not this file.
[ -n "${SSH_ORIGINAL_COMMAND:-}" ] || {
	printf 'this key manages open-mcc instances; it has no interactive shell\n' >&2
	exit 1
}
exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"
WRAPPER_EOF
	chmod 700 "$WRAPPER"
	say "Wrote the forced command to $WRAPPER"
fi

# 5. The authorized_keys entry. Append only, and only when this exact key is
#    not already listed. What was there, and what this run made of it, are kept
#    aside until the run finishes.

make_ssh_dir

if [ "$LISTED" = "yes" ]; then
	say "authorized_keys already carries this key with these restrictions"
else
	if [ -f "$AUTHORIZED" ]; then
		cp "$AUTHORIZED" "$AUTHORIZED_BEFORE"
		KEPT_AUTHORIZED="yes"
	else
		WROTE_AUTHORIZED="yes"
		: > "$AUTHORIZED"
	fi
	# A file whose last line has no newline would otherwise swallow our entry
	# into somebody else's.
	if [ -s "$AUTHORIZED" ] && [ -n "$(tail -c 1 "$AUTHORIZED")" ]; then
		printf '\n' >> "$AUTHORIZED"
	fi
	printf '%s\n' "$ENTRY" >> "$AUTHORIZED"
	cp "$AUTHORIZED" "$AUTHORIZED_AFTER"
	say "Added a restricted entry to $AUTHORIZED"
fi

# 6. Prove the entry works from this machine before believing anything about it.

VERIFY_OPTIONS="-o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no"
VERIFY_OPTIONS="$VERIFY_OPTIONS -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10"

if [ -n "$PRIVATE_KEY_PATH" ]; then
	# shellcheck disable=SC2086
	WHO="$(ssh -i "$PRIVATE_KEY_PATH" -p "$SSH_PORT" $VERIFY_OPTIONS "$ACCOUNT@127.0.0.1" 'id -un' 2>/dev/null || true)"
	[ "$WHO" = "$ACCOUNT" ] || die "the new key did not authenticate to 127.0.0.1:$SSH_PORT as $ACCOUNT.
       sshd may be refusing the options on the entry (it needs OpenSSH 7.2 or newer),
       or its config may forbid this account or public keys. Check the sshd log."
	# shellcheck disable=SC2086
	if ssh -i "$PRIVATE_KEY_PATH" -p "$SSH_PORT" $VERIFY_OPTIONS "$ACCOUNT@127.0.0.1" </dev/null >/dev/null 2>&1; then
		die "the key opened a session without naming a command, so the forced command at $WRAPPER is not taking effect.
       Nothing this run wrote was kept. Restore that file, or delete it so this can write it again."
	fi
	say "The key authenticates as $ACCOUNT and gets no interactive shell"
else
	say "Skipping the local check: the private half of a supplied key stays in the control plane"
fi

# 7. The two things about this machine an operator has to act on, reported
#    rather than re-checked — provisioning already blocks on both.

if command -v systemctl >/dev/null 2>&1; then
	SYSTEMD="yes"
else
	SYSTEMD="no"
	warn "this machine has no systemd, so it cannot run instances. Enrolling it will fail at provisioning."
fi

LINGER="unknown"
if command -v loginctl >/dev/null 2>&1; then
	LINGER="$(loginctl show-user "$ACCOUNT" --property=Linger --value 2>/dev/null || printf no)"
fi
if [ "$LINGER" != "yes" ] && [ "$SYSTEMD" = "yes" ]; then
	warn "lingering is off for $ACCOUNT, so instances would stop when you log out.
         Run 'sudo loginctl enable-linger $ACCOUNT'. It is the one step here that needs root."
fi

# 8. Which address reaches this machine from inside the control plane's
#    container. Every candidate is tried, and one is only accepted when the host
#    key it presents is one of this machine's own — otherwise a neighbouring
#    sshd (a container runtime's own VM, say) would be enrolled as "this
#    machine" and every later failure would look like a network fault.

PROBE_JS='
const { Client } = require("ssh2");
const { createHash } = require("crypto");
const { readFileSync } = require("fs");

const port = Number(process.env.SELF_HOST_PORT);
const account = process.env.SELF_HOST_ACCOUNT;
const timeout = Number(process.env.SELF_HOST_TIMEOUT_MS);
const wanted = new Set(String(process.env.SELF_HOST_FINGERPRINTS).split(",").filter(Boolean));

const fingerprintOf = (key) =>
  "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
const algorithmOf = (key) => key.subarray(4, 4 + key.readUInt32BE(0)).toString("ascii");

const defaultGateway = () => {
  try {
    for (const line of readFileSync("/proc/net/route", "utf8").split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length > 2 && columns[1] === "00000000") {
        const hex = columns[2];
        return [3, 2, 1, 0].map((i) => parseInt(hex.substr(i * 2, 2), 16)).join(".");
      }
    }
  } catch {}
  return undefined;
};

const candidates = [
  "host.docker.internal",
  "host.containers.internal",
  "gateway.docker.internal",
  defaultGateway(),
].filter((each, index, all) => each && all.indexOf(each) === index);

const identify = (host) =>
  new Promise((resolve) => {
    const conn = new Client();
    let key;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      conn.destroy();
      resolve(key);
    };
    const timer = setTimeout(finish, timeout);
    conn.on("error", finish).on("close", () => {
      clearTimeout(timer);
      finish();
    });
    conn.connect({
      host,
      port,
      username: "probe",
      readyTimeout: timeout,
      hostVerifier: (presented) => {
        key = Buffer.from(presented);
        return false;
      },
    });
  });

const authenticate = (host, privateKey, expected) =>
  new Promise((resolve) => {
    const conn = new Client();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { conn.end(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, why: "timed out" }), timeout);
    conn.on("error", (error) => finish({ ok: false, why: error.message }));
    conn.on("ready", () => {
      conn.exec("printf %s \"${SSH_CONNECTION%% *}\"", (error, stream) => {
        if (error) return finish({ ok: false, why: error.message });
        let out = "";
        stream.on("data", (chunk) => { out += chunk; });
        stream.on("close", () => {
          conn.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (forwardError, socket) => {
            if (!forwardError && socket) socket.destroy();
            finish({ ok: true, source: out.trim(), forwards: !forwardError });
          });
        });
      });
    });
    conn.connect({
      host,
      port,
      username: account,
      privateKey,
      readyTimeout: timeout,
      hostVerifier: (presented) => fingerprintOf(presented) === expected,
    });
  });

const readStdin = () =>
  new Promise((resolve) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buffer += chunk; });
    process.stdin.on("end", () => resolve(buffer));
  });

(async () => {
  const privateKey = await readStdin();
  for (const candidate of candidates) {
    const key = await identify(candidate);
    if (!key) {
      console.log("note=" + candidate + " did not answer ssh");
      continue;
    }
    const fingerprint = fingerprintOf(key);
    if (!wanted.has(fingerprint)) {
      console.log("note=" + candidate + " answered, but it is a different machine");
      continue;
    }
    console.log("ADDRESS=" + candidate);
    console.log("FINGERPRINT=" + fingerprint);
    console.log("ALGORITHM=" + algorithmOf(key));
    if (privateKey.trim().length > 0) {
      const result = await authenticate(candidate, privateKey, fingerprint);
      console.log("AUTH=" + (result.ok ? "ok" : "failed"));
      if (result.ok) {
        console.log("SOURCE=" + result.source);
        console.log("FORWARDS=" + (result.forwards ? "yes" : "no"));
      } else {
        console.log("note=" + result.why);
      }
    }
    return;
  }
  console.log("note=no candidate address reached this machine");
})();
'

IMAGE="${OPEN_MCC_IMAGE:-}"
if [ -z "$IMAGE" ] && command -v docker >/dev/null 2>&1 && [ -f docker/compose.yml ]; then
	IMAGE="$(docker compose -f docker/compose.yml config --images 2>/dev/null | grep -i server | head -1 || true)"
fi

ADDRESS=""
FINGERPRINT=""
ALGORITHM=""
SOURCE=""
REACH="unproven"

if ! command -v docker >/dev/null 2>&1; then
	warn "docker was not found, so the address the control plane can reach this machine on is unproven"
elif [ -z "$IMAGE" ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
	warn "the control plane image is not built yet, so the address it can reach this machine on is unproven.
         Run this again after 'docker compose -f docker/compose.yml build server'."
else
	# The same --add-host the compose services carry, so the name the probe proves is
	# the name the control plane can resolve. Docker Desktop and OrbStack resolve it
	# on their own; native Docker Engine does not, and would otherwise leave a bridge
	# gateway address here that changes whenever the network is recreated.
	set -- run --rm -i --add-host "host.docker.internal:host-gateway"
	if docker network inspect "${PROJECT}_default" >/dev/null 2>&1; then
		set -- "$@" --network "${PROJECT}_default"
		NETWORK_NOTE="on the ${PROJECT}_default network"
	else
		NETWORK_NOTE="on the default bridge, because ${PROJECT}_default does not exist yet"
	fi
	set -- "$@" -e "SELF_HOST_PORT=$SSH_PORT" -e "SELF_HOST_ACCOUNT=$ACCOUNT"
	set -- "$@" -e "SELF_HOST_TIMEOUT_MS=$TIMEOUT_MS" -e "SELF_HOST_FINGERPRINTS=$FINGERPRINT_LIST"
	set -- "$@" "$IMAGE" -e "$PROBE_JS"

	say "Probing from a container built on $IMAGE, $NETWORK_NOTE"
	if [ -n "$PRIVATE_KEY_PATH" ]; then
		PROBE_OUT="$(docker "$@" < "$PRIVATE_KEY_PATH" 2>&1 || true)"
	else
		PROBE_OUT="$(docker "$@" < /dev/null 2>&1 || true)"
	fi

	ADDRESS="$(printf '%s\n' "$PROBE_OUT" | sed -n 's/^ADDRESS=//p' | head -1)"
	FINGERPRINT="$(printf '%s\n' "$PROBE_OUT" | sed -n 's/^FINGERPRINT=//p' | head -1)"
	ALGORITHM="$(printf '%s\n' "$PROBE_OUT" | sed -n 's/^ALGORITHM=//p' | head -1)"
	SOURCE="$(printf '%s\n' "$PROBE_OUT" | sed -n 's/^SOURCE=//p' | head -1)"
	PROBE_AUTH="$(printf '%s\n' "$PROBE_OUT" | sed -n 's/^AUTH=//p' | head -1)"
	PROBE_FORWARDS="$(printf '%s\n' "$PROBE_OUT" | sed -n 's/^FORWARDS=//p' | head -1)"

	printf '%s\n' "$PROBE_OUT" | sed -n 's/^note=/  /p'

	if [ -z "$ADDRESS" ]; then
		warn "no address reached this machine's sshd from a container.
         The control plane cannot manage this machine until one does. On Linux, sshd
         must listen on an address the container bridge can reach, not only 127.0.0.1,
         and the firewall must allow it."
	elif [ -n "$PRIVATE_KEY_PATH" ] && [ "$PROBE_AUTH" != "ok" ]; then
		REACH="reachable"
		warn "$ADDRESS reaches this machine, but the key did not authenticate from the container.
         sshd may be restricting where this account may connect from."
	else
		REACH="proven"
		say "The control plane can reach this machine at $ADDRESS:$SSH_PORT"
		if [ "$PROBE_FORWARDS" = "no" ]; then
			warn "port forwarding did not work through that connection, so live instance control will not either"
		fi
	fi
fi

# Materials with no address describe a machine the control plane cannot enroll,
# and install.sh would tell the operator it had been offered. Stop instead, and
# take back the entry.

[ -n "$ADDRESS" ] || die "this machine was not offered: no address the control plane can reach it on was proven.
       Nothing was left behind. Deal with the warning above, then run this again."

if [ -z "$FINGERPRINT" ]; then
	FINGERPRINT="$(printf '%s\n' "$HOST_KEYS" | grep ' ssh-ed25519 ' | ssh-keygen -lf - 2>/dev/null | awk '{print $2}' | head -1 || true)"
	[ -n "$FINGERPRINT" ] || FINGERPRINT="$(printf '%s\n' "$FINGERPRINTS" | head -1)"
	ALGORITHM="${ALGORITHM:-unproven}"
fi

# 9. The materials. Names match the fields host enrollment asks for, and the
#    file is shaped to be appended to .env, because that is the only channel the
#    control-plane container reads from: it mounts nothing. No secret is written
#    here or printed above; the private key stays where it was made.

cat > "$MATERIALS" <<MATERIALS_EOF
# Written by scripts/self-host.sh for enrolling this machine as its own host.
# The field names match what host enrollment asks for. Append this to .env so
# the control plane can offer this machine without anyone typing a fingerprint.
SELF_HOST_NAME=$MACHINE
SELF_HOST_HOSTNAME=$ADDRESS
SELF_HOST_PORT=$SSH_PORT
SELF_HOST_USERNAME=$ACCOUNT
SELF_HOST_MODE=rootless
SELF_HOST_FINGERPRINT=$FINGERPRINT
SELF_HOST_KEY_ALGORITHM=$ALGORITHM
SELF_HOST_PUBLIC_KEY=$PUBLIC_KEY
SELF_HOST_PRIVATE_KEY_PATH=$PRIVATE_KEY_PATH
SELF_HOST_REACH=$REACH
SELF_HOST_SOURCE_ADDRESS=$SOURCE
SELF_HOST_SYSTEMD=$SYSTEMD
SELF_HOST_LINGER=$LINGER
MATERIALS_EOF

FINISHED="yes"
rm -f "$AUTHORIZED_BEFORE" "$AUTHORIZED_AFTER"

say ""
say "Wrote $MATERIALS, mode 600"
say ""
say "  address      ${ADDRESS:-not proven}"
say "  port         $SSH_PORT"
say "  username     $ACCOUNT"
say "  fingerprint  $FINGERPRINT"
say "  mode         rootless"
say ""
if [ -n "$PRIVATE_KEY_PATH" ]; then
	say "The private key is at $PRIVATE_KEY_PATH, in plaintext, because this run minted it."
	say "scripts/install.sh does not go this way. It has the control plane mint the key and"
	say "seal it with SEALBOX_KEYS, then passes only the public half here:"
	say "  docker run --rm -e SEALBOX_KEYS -i <server-image> server.mjs --seal-self-host-key"
	say ""
fi
say "This key can run any command as $ACCOUNT. The restrictions on it stop it opening a"
say "shell, forwarding an agent, or reaching anything but this machine's own loopback."

#!/usr/bin/env sh
set -eu

REPO="${OPEN_MCC_REPO:-https://github.com/thinesjs/open-mcc-manager.git}"
TARGET="${OPEN_MCC_DIR:-open-mcc-manager}"
DEV_KEY_ID="dev-insecure-publicly-known"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but was not found on PATH"; }

random_secret() {
	if command -v openssl >/dev/null 2>&1; then openssl rand -base64 32
	else head -c 32 /dev/urandom | base64 | tr -d '\n'; fi
}

port_is_free() {
	command -v nc >/dev/null 2>&1 || return 0
	if nc -z 127.0.0.1 "$1" >/dev/null 2>&1; then
		return 1
	fi
	return 0
}

free_port() {
	port="$1"
	limit=$((port + 60))
	while [ "$port" -lt "$limit" ]; do
		if port_is_free "$port"; then printf '%s' "$port"; return 0; fi
		port=$((port + 1))
	done
	die "no free port found starting at $1"
}

need docker
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"

if [ -f docker/compose.yml ] && [ -f package.json ]; then
	say "Using the checkout in $(pwd)"
else
	need git
	if [ -d "$TARGET/.git" ]; then
		say "Reusing the existing checkout in $TARGET"
	else
		say "Cloning $REPO into $TARGET"
		git clone --depth 1 "$REPO" "$TARGET" || die "could not clone $REPO"
	fi
	cd "$TARGET"
fi

[ -f .env ] && die ".env already exists here — refusing to overwrite existing secrets"

PROJECT="${COMPOSE_PROJECT_NAME:-open-mcc}"
if docker volume inspect "${PROJECT}_pgdata" >/dev/null 2>&1; then
	die "a database volume ${PROJECT}_pgdata already exists, so this machine already has an install.
       Postgres only applies POSTGRES_PASSWORD when its volume is first created, so a fresh
       password would not be able to authenticate against it. Reuse the existing .env, or
       remove the volume with 'docker volume rm ${PROJECT}_pgdata' to start over and lose its data."
fi

DB_PORT="$(free_port "${OPEN_MCC_DB_PORT:-25432}")"
TEST_DB_PORT="$(free_port $((DB_PORT + 1)))"
SERVER_PORT="$(free_port "${OPEN_MCC_SERVER_PORT:-25174}")"
WEB_PORT="$(free_port "${OPEN_MCC_WEB_PORT:-25173}")"

say "Building the control-plane image (this takes a few minutes on a cold cache)"
docker compose -f docker/compose.yml build server >/dev/null || die "image build failed"

IMAGE="$(docker compose -f docker/compose.yml config --images 2>/dev/null | grep -i server | head -1)"
[ -n "$IMAGE" ] || die "could not determine the built server image"

say "Generating a sealbox keypair"
SEALBOX_KEYS="$(docker run --rm "$IMAGE" server.mjs --generate-sealbox-key k1)" ||
	die "could not generate a sealbox key"

case "$SEALBOX_KEYS" in
	"$DEV_KEY_ID"*) die "refusing to install with the publicly known development key" ;;
	*:*:*) : ;;
	*) die "generated sealbox key has an unexpected shape" ;;
esac

BETTER_AUTH_SECRET="$(random_secret)"
POSTGRES_PASSWORD="$(random_secret | tr -dc 'A-Za-z0-9' | cut -c1-32)"
[ -n "$POSTGRES_PASSWORD" ] || die "could not generate a database password"

umask 077
cat > .env <<ENVFILE
COMPOSE_PROJECT_NAME=$PROJECT
DEV_DB_PORT=$DB_PORT
TEST_DB_PORT=$TEST_DB_PORT
SERVER_PORT=$SERVER_PORT
WEB_PORT=$WEB_PORT
SERVER_ORIGIN=http://localhost:$SERVER_PORT
DATABASE_URL=postgres://postgres:$POSTGRES_PASSWORD@localhost:$DB_PORT/open_mcc_manager
TEST_DATABASE_URL=postgres://postgres:$POSTGRES_PASSWORD@localhost:$TEST_DB_PORT/postgres
PORT=$SERVER_PORT
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET
BETTER_AUTH_URL=http://localhost:$SERVER_PORT
SEALBOX_KEYS=$SEALBOX_KEYS
ALLOWED_ORIGINS=http://localhost:$WEB_PORT
INSTANCES_ROOT=/srv/open-mcc
ENVFILE

say "Wrote .env with generated secrets, mode 600"

docker compose --env-file .env -f docker/compose.yml up -d

say ""
say "Control plane starting on http://localhost:$SERVER_PORT"
say ""
say "Next:"
say "  1. Back up .env now. Losing SEALBOX_KEYS makes every stored ssh key unreadable."
say "  2. Create the first owner account, then enroll a host with its ssh host key fingerprint."
say "  3. To reach hosts by MagicDNS name over a tailnet, add -f docker/compose.tailnet.yml and set TAILNET_DNS_SUFFIX."

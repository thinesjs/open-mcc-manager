FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm dlx esbuild@0.25.12 apps/server/src/index.ts \
	--bundle --platform=node --format=esm --target=node22 \
	--outfile=server.mjs \
	--external:@hono/node-server --external:@hono/trpc-server --external:@trpc/server \
	--external:argon2 --external:better-auth --external:better-auth/* \
	--external:hono --external:hono/* --external:kysely --external:kysely/* \
	--external:libsodium-wrappers-sumo --external:nanoid --external:pg \
	--external:ssh2 --external:sshpk --external:zod
RUN pnpm deploy --filter @open-mcc/server --prod --legacy --config.node-linker=hoisted /out
RUN cp server.mjs /out/server.mjs
RUN test -d /out/node_modules/argon2/prebuilds

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /out /app
USER nonroot
EXPOSE 3000
CMD ["server.mjs"]

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps ./apps
COPY packages ./packages
COPY docker/server/prune-deploy.mjs ./prune-deploy.mjs
RUN pnpm install --frozen-lockfile
RUN pnpm dlx esbuild@0.25.12 apps/server/src/index.ts \
	--bundle --platform=node --format=esm --target=node22 \
	"--banner:js=import{createRequire as __ocr}from'node:module';var require=__ocr(import.meta.url);" \
	--outfile=server.mjs \
	--external:@hono/node-server --external:@hono/trpc-server --external:@trpc/server \
	--external:argon2 --external:better-auth --external:better-auth/* \
	--external:hono --external:hono/* --external:kysely --external:kysely/* \
	--external:libsodium-wrappers-sumo --external:nanoid --external:pg \
	--external:pg-boss --external:undici \
	--external:ssh2 --external:sshpk --external:zod
RUN pnpm dlx esbuild@0.25.12 packages/db/src/migrate.ts \
	--bundle --platform=node --format=esm --target=node22 \
	"--banner:js=import{createRequire as __ocr}from'node:module';var require=__ocr(import.meta.url);" \
	--outfile=migrate.mjs \
	--external:kysely --external:kysely/* --external:pg
RUN pnpm deploy --filter @open-mcc/server --prod --legacy --config.node-linker=hoisted /out
RUN cp server.mjs /out/server.mjs
RUN mkdir -p /migrate/db && cp migrate.mjs /migrate/db/migrate.mjs
RUN cp -r packages/db/migrations /migrate/migrations
RUN test -d /out/node_modules/argon2/prebuilds
RUN node prune-deploy.mjs /out

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS migrate
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ENV APP_VERSION=$APP_VERSION
ENV GIT_SHA=$GIT_SHA
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /out /app
COPY --from=build --chown=nonroot:nonroot /migrate /app
USER nonroot
CMD ["db/migrate.mjs"]

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ENV APP_VERSION=$APP_VERSION
ENV GIT_SHA=$GIT_SHA
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /out /app
USER nonroot
EXPOSE 3000
CMD ["server.mjs"]

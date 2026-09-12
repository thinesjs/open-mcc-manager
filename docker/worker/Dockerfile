FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps ./apps
COPY packages ./packages
COPY docker/server/prune-deploy.mjs ./prune-deploy.mjs
COPY docker/third-party-notices.mjs ./third-party-notices.mjs
RUN pnpm install --frozen-lockfile
RUN pnpm dlx esbuild@0.25.12 apps/worker/src/index.ts \
	--bundle --platform=node --format=esm --target=node22 \
	"--banner:js=import{createRequire as __ocr}from'node:module';var require=__ocr(import.meta.url);" \
	--outfile=worker.mjs --metafile=meta-worker.json \
	--external:kysely --external:kysely/* \
	--external:libsodium-wrappers-sumo --external:nanoid --external:pg \
	--external:pg-boss --external:ssh2 --external:sshpk --external:undici --external:zod
RUN pnpm deploy --filter @open-mcc/worker --prod --legacy --config.node-linker=hoisted /out
RUN cp worker.mjs /out/worker.mjs
RUN node prune-deploy.mjs /out
RUN node third-party-notices.mjs /app /out /notices/THIRD-PARTY-NOTICES.txt meta-worker.json

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ENV APP_VERSION=$APP_VERSION
ENV GIT_SHA=$GIT_SHA
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /out /app
COPY --from=build /notices/THIRD-PARTY-NOTICES.txt /licenses/THIRD-PARTY-NOTICES.txt
USER nonroot
CMD ["worker.mjs"]

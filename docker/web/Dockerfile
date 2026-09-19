FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps ./apps
COPY packages ./packages
COPY docker/third-party-notices.mjs ./third-party-notices.mjs
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @open-mcc/web build
RUN pnpm dlx esbuild@0.25.12 apps/web-server/src/index.ts \
	--bundle --platform=node --format=esm --target=node22 \
	"--banner:js=import{createRequire as __ocr}from'node:module';var require=__ocr(import.meta.url);" \
	--outfile=web.mjs --metafile=meta-web.json
RUN mkdir -p /out/dist
RUN cp web.mjs /out/web.mjs
RUN cp -r apps/web/dist/. /out/dist/
RUN test -f /out/dist/index.html
RUN test -d /out/dist/assets
RUN test "$(ls -A /out | sort | tr '\n' ',')" = "dist,web.mjs,"
RUN pnpm deploy --filter @open-mcc/web --prod --legacy --config.node-linker=hoisted /third-party
RUN cp -RL apps/web/node_modules/tailwindcss /third-party/node_modules/tailwindcss
RUN cp -RL apps/web/node_modules/vite /third-party/node_modules/vite
RUN rm -rf /third-party/node_modules/@open-mcc
RUN node third-party-notices.mjs /app /third-party /notices/THIRD-PARTY-NOTICES.txt meta-web.json

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ENV APP_VERSION=$APP_VERSION
ENV GIT_SHA=$GIT_SHA
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /out /app
COPY --from=build /notices/THIRD-PARTY-NOTICES.txt /licenses/THIRD-PARTY-NOTICES.txt
USER nonroot
EXPOSE 3000
CMD ["web.mjs"]

# ── Stage 1: Build Svelte frontend ──────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
# scripts/postinstall.cjs is referenced by the "postinstall" npm hook, so it
# must exist before npm install runs. Copy it explicitly here so we don't
# bust the rest of the source-code Docker layer cache on every change.
COPY scripts/ ./scripts/
RUN npm install
COPY . .
RUN npm run build

# ── Stage 2: Express server + static frontend ────────────────────────────────
FROM node:20-alpine
# python3 + make + g++ are needed by better-sqlite3's native build.
# py3-pip + the recipe-scrapers Python lib power the "Enhanced" URL
# import tier (300+ site-specific extractors) — same container, no
# sidecar. Mealie ships this lib inline because their backend is
# Python; we install it alongside Node so the Node scrape route can
# shell out to it via subprocess. The --break-system-packages flag
# is required by pip on Alpine 3.18+ which marks system Python as
# externally managed.
RUN apk add --no-cache python3 py3-pip make g++ \
    && pip3 install --no-cache-dir --break-system-packages 'recipe-scrapers>=14.0.0'
WORKDIR /app
COPY server/package*.json ./
RUN npm install --omit=dev
COPY server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
COPY server/ .
COPY --from=build /app/dist ./dist
# Also ship the root package.json so the server can read APP_VERSION
# from it at runtime. The `COPY server/package*.json ./` step above
# put the SERVER package.json at /app/package.json; overwriting it
# with the ROOT one here makes version-source.js report the correct
# client-facing version instead of the stale server-side one.
COPY --from=build /app/package.json ./package.json
# Bake the app version into the image so the in-app updates checker
# can report the running server version. CI can pass
# `--build-arg APP_VERSION=$(node -p 'require("./package.json").version')`.
# Falls back to reading /app/package.json at runtime.
ARG APP_VERSION=""
ENV TRACEAPPS_APP_VERSION=${APP_VERSION}
EXPOSE 3001
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "index.js"]

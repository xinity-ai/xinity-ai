# syntax=docker/dockerfile:1

ARG BUN_VERSION=1.3.1

# ---------- base (shared manifest layer) ----------
# All workspace package.jsons must be present for bun install to resolve the lockfile.
FROM oven/bun:${BUN_VERSION}-slim AS xinity-base
WORKDIR /usr/src/app

# Copy only manifests first (maximizes layer cache)
# [sync:workspace-manifests] - auto-generated, do not edit
COPY package.json bun.lock ./
COPY packages/common-db/package.json packages/common-db/package.json
COPY packages/common-env/package.json packages/common-env/package.json
COPY packages/common-log/package.json packages/common-log/package.json
COPY packages/xinity-ai-daemon/package.json packages/xinity-ai-daemon/package.json
COPY packages/xinity-ai-dashboard/package.json packages/xinity-ai-dashboard/package.json
COPY packages/xinity-ai-gateway/package.json packages/xinity-ai-gateway/package.json
COPY packages/xinity-cli/package.json packages/xinity-cli/package.json
COPY packages/xinity-infoserver/package.json packages/xinity-infoserver/package.json
# [/sync:workspace-manifests]

FROM xinity-base AS deps
# Install deps needed for building (includes devDependencies)
RUN --mount=type=cache,target=/root/.bun \
  bun install --frozen-lockfile

FROM deps AS build
WORKDIR /usr/src/app
COPY . .

WORKDIR /usr/src/app/packages/xinity-infoserver
ENV NODE_ENV=production
RUN bun build server.ts --outdir dist --target bun


# ---------- runtime (small) ----------
FROM xinity-base AS runtime
WORKDIR /usr/src/app

ENV NODE_ENV=production

RUN --mount=type=cache,target=/root/.bun \
  cd packages/xinity-infoserver \
  && bun install --frozen-lockfile --production \
  && rm -rf /tmp/*

# Copy only built artifacts (not the whole repo, not dev node_modules)
WORKDIR /usr/src/app/packages/xinity-infoserver
COPY --from=build /usr/src/app/packages/xinity-infoserver/dist ./dist

USER bun
ENV MODEL_INFO_DIR=/data/models.d PORT=8090
EXPOSE 8090/tcp
CMD [ "bun", "run", "dist/server.js" ]

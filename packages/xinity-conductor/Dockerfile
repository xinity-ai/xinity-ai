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
COPY packages/xinity-conductor/package.json packages/xinity-conductor/package.json
COPY packages/xinity-infoserver/package.json packages/xinity-infoserver/package.json
# [/sync:workspace-manifests]

FROM xinity-base AS deps
# Install deps needed for building (includes devDependencies)
RUN --mount=type=cache,target=/root/.bun \
  bun install --frozen-lockfile

FROM deps AS build
WORKDIR /usr/src/app
COPY . .

WORKDIR /usr/src/app/packages/xinity-conductor
ENV NODE_ENV=production
RUN bun build src/index.ts --outdir dist --target bun


# ---------- runtime (small) ----------
FROM xinity-base AS runtime
WORKDIR /usr/src/app

ENV NODE_ENV=production

RUN --mount=type=cache,target=/root/.bun \
  cd packages/xinity-conductor \
  && bun install --frozen-lockfile --production \
  && rm -rf /tmp/*

# Copy only built artifacts (not the whole repo, not dev node_modules)
WORKDIR /usr/src/app/packages/xinity-conductor
COPY --from=build /usr/src/app/packages/xinity-conductor/dist ./dist

USER bun
ENV PORT=4020 HOST=0.0.0.0
EXPOSE 4020/tcp
CMD [ "bun", "run", "dist/index.js" ]

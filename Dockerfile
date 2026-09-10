# syntax=docker/dockerfile:1

# node:22-slim plus Chromium only, rather than the Playwright base image: that
# one ships Chromium, Firefox AND WebKit and lands at ~3.8GB, and the proforma
# and deck renderers use exactly one browser. The Chromium build is still
# Playwright's own and is pinned by the playwright-core version in the
# lockfile, because a library/browser mismatch fails at render time rather than
# at boot -- which is to say, on someone's invoice.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# openssl and ca-certificates: Prisma's engine links against libssl, and the
# API talks to Neon and Resend over TLS.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# ---- dependencies -----------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY packages/contracts packages/contracts
COPY apps/api apps/api
# The generated client lands in apps/api/src/generated, so it must exist before tsc.
RUN pnpm --filter @merchforce/contracts exec prisma generate \
 && pnpm --filter @merchforce/api exec tsc -p tsconfig.json

# ---- browser ----------------------------------------------------------------
# Its own stage so the ~400MB of apt lists and build noise never reaches the
# runtime layer; only /ms-playwright and the shared libraries are carried over.
FROM base AS browser
RUN npx --yes playwright@1.63.0 install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

# ---- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The system libraries Chromium links against. Installed here rather than
# copied, so the package manager owns them and they stay consistent.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
      libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 \
      libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
      fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

COPY --from=browser /ms-playwright /ms-playwright
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=deps  /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps  /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
# The compiled code imports '../generated/prisma/index.js' relative to itself,
# so from dist/ that resolves to dist/generated — not src/generated, which is
# where prisma generate puts it and where tsx finds it in development. tsc does
# not emit it (src/generated is excluded), so it is placed here explicitly.
COPY --from=build /app/apps/api/src/generated ./apps/api/dist/generated
COPY --from=build /app/packages/contracts/prisma ./packages/contracts/prisma
COPY package.json pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
# Migrations run as the release command and need the schema and the CLI.
COPY apps/api/scripts ./apps/api/scripts

RUN useradd -m -u 10001 merchforce && chown -R merchforce:merchforce /app
USER merchforce
EXPOSE 8901
# No --env-file here: Fly injects secrets as real environment variables, and
# env.ts fails loudly at boot if any of them are missing.
CMD ["node", "apps/api/dist/server.js"]

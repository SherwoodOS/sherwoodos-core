# syntax=docker/dockerfile:1

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY backend/package.json ./backend/package.json
RUN --mount=type=cache,id=bun-cache-sherwood-core,sharing=locked,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts --production

FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=ghcr.io/foundry-rs/foundry:v1.8.1 --chown=bun:bun /usr/local/bin/anvil /usr/local/bin/anvil

COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun backend ./backend
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun --chmod=755 entrypoint.sh ./entrypoint.sh

RUN mkdir -p /data && chown bun:bun /data
USER bun

EXPOSE 3000
ENTRYPOINT ["/app/entrypoint.sh"]

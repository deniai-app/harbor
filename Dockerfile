FROM oven/bun:1.1-alpine AS deps
WORKDIR /app

RUN apk add --no-cache git ca-certificates

# Copy workspace manifest files for deterministic install cache
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

RUN bun install --frozen-lockfile

FROM oven/bun:1.1-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache git ca-certificates

COPY --from=deps /root/.bun /root/.bun
COPY . .

# workspace node_modules from deps stage
COPY --from=deps /app/node_modules /app/node_modules

ENV NODE_ENV=production
EXPOSE 8787

CMD ["bun", "run", "--filter", "api", "start"]

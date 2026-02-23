FROM oven/bun:1.3.9-alpine AS deps
WORKDIR /app

RUN apk add --no-cache git ca-certificates

# Copy workspace manifest files for deterministic install cache
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY packages/ui/package.json ./packages/ui/
COPY packages/typescript-config/package.json ./packages/typescript-config/

RUN bun install --frozen-lockfile

FROM oven/bun:1.3.9-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache git ca-certificates

COPY --from=deps /root/.bun /root/.bun
COPY . .

# workspace node_modules from deps stage
COPY --from=deps /app/node_modules /app/node_modules

ENV NODE_ENV=production
EXPOSE 8787

CMD ["bun", "run", "--cwd", "apps/api", "start"]

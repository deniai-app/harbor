# Deni AI Harbor

Deni AI Harbor is a GitHub App that adds automated, suggestion-only PR reviews using AI.

- It **keeps changes safe** by posting only inline `suggestion` comments.
- It runs as a bot on GitHub webhooks for pull requests and review events.
- It is intended for low-noise review flows in teams.

## Quick links

- [Product details](./PRODUCT.md)
- [Contributing guide](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)
- [Code of conduct](./CODE_OF_CONDUCT.md)

## Try it locally

```bash
bun install
cp .env.example .env
bun run dev
```

- Web app: `http://localhost:3000`
- API: `http://localhost:8787`
- Health endpoint: `GET http://localhost:8787/healthz`

This repository is a monorepo with:

- `apps/web` (Next.js UI)
- `apps/api` (Hono API)
- `packages/shared` (shared types and helpers)

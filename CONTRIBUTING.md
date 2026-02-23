# Contributing to Deni AI Harbor

Welcome, and thanks for your interest in contributing.

## Development setup

```bash
bun install
cp .env.example .env
bun run dev
```

- `apps/web`: frontend
- `apps/api`: backend API
- `packages/shared`: shared utilities/types

Useful commands:

- `bun run build` — build all workspace packages
- `bun run lint` — run linters
- `bun run format` — format code

## Contribution flow

1. Create a branch from `canary` for feature work.
2. Add tests or small reproducible checks where applicable.
3. Keep changes focused and minimal.
4. Open a pull request with concise summary and motivation.

## Issue reports

If you find a bug:

- Include repro steps and expected behavior.
- Mention your environment and versions (`bun`, `node`, Docker, etc.).

## Code style

- Prefer clear and defensive implementations.
- Keep security-sensitive paths minimal and explicit.
- Avoid noisy or broad auto-approve behavior in default settings.

# Repository Guidelines

## Project Structure & Module Organization
This is a Bun/Turbo monorepo.

- `apps/api/src`: Hono-based GitHub App backend (webhooks, GitHub client, review workers).
- `apps/api/tests`: API unit tests (`vitest`).
- `apps/web`: Next.js frontend (`app/`, `components/`, `hooks/`, `lib/`).
- `packages/shared/src`: shared types and utilities used by multiple apps.
- `packages/ui/src`: reusable UI primitives/components.
- `packages/typescript-config`: shared TS config presets.

Keep feature logic inside its owning app/package; only move code to `packages/shared` when it is genuinely reused.

## Build, Test, and Development Commands
Run from repo root unless noted.

- `bun install`: install workspace dependencies.
- `bun run dev`: start all workspaces in dev mode (Turbo).
- `bun run build`: build all workspaces.
- `bun run lint`: run `oxlint` across workspaces.
- `bun run format` / `bun run format:check`: format or verify formatting with `oxfmt`.
- `bun run --cwd apps/api test`: run backend tests with Vitest.
- `bun run --cwd apps/api typecheck`: API TypeScript checks.
- `bun run --cwd apps/web typecheck`: Web TypeScript checks.

## Coding Style & Naming Conventions
- Language: TypeScript (ESM modules).
- Formatting: 2-space indentation, semicolons, and explicit types at boundaries.
- Linting/formatting tools: `oxlint` and `oxfmt`.
- File naming: prefer lowercase kebab-case for modules (example: `process-pr.ts`).
- Keep functions focused; isolate GitHub/API side effects in client/service modules.

## Testing Guidelines
- Framework: Vitest (`apps/api/tests`).
- Test files should use `*.test.ts` naming (example: `patch.test.ts`).
- Add tests for parsing, mapping, and safety-critical logic before refactors.
- No strict coverage gate is enforced yet; prioritize meaningful regression tests.

## Commit & Pull Request Guidelines
- Follow Conventional Commit style seen in history: `fix: ...`, `chore: ...`, `docs: ...`, optional scopes (example: `chore(deploy): ...`).
- Keep commits small and single-purpose.
- Open PRs from `canary`-based branches (per `CONTRIBUTING.md`), with:
  - concise summary and motivation,
  - linked issue (if applicable),
  - test notes (what was run and result),
  - screenshots for UI changes in `apps/web`.

## Security & Configuration Tips
- Copy `.env.example` to `.env` for local setup; never commit secrets.
- Validate webhook/auth changes carefully in `apps/api/src/security` and `apps/api/src/github`.

# Deni AI Harbor

Deni AI Harbor is a production-oriented GitHub App that posts **safe, suggestion-only PR reviews** automatically.

- Web: `apps/web` (Next.js)
- API: `apps/api` (Hono, Node)
- Shared: `packages/shared`
- Deployment target: self-hosted Docker stack (Dokploy / Coolify / your own infrastructure)

## What it does (v1)

1. Accepts GitHub App webhooks (`pull_request: opened/synchronize`, `issue_comment: created`, `pull_request_review: submitted/edited`, `pull_request_review_comment: created`).
2. Verifies `X-Hub-Signature-256` before handling payload.
3. Generates installation tokens and fetches changed files for the PR.
4. Computes diff positions for added lines and builds robust patch mapping.
5. Provides read-only virtual IDE tools via function calling to the LLM.
6. Posts inline review comments with ````suggestion````, and optionally auto-approves only when confidence is high.
7. Executes only on authorized mention paths for certain webhook event types to avoid noisy automation.
8. Falls back to PR summary comments when inline attachment is not safe.

## Repository layout

```text
/apps/web
/apps/api
/packages/shared
```

## Production profile / behavior

- Safe mode first: suggestions are emitted only when they stay within changed lines and are small, low-risk edits.
- Auto-approve is conservative: requires explicit model confidence (`overallStatus: ok`) and `overallComment` match.
- No file writes are performed by the LLM: only read-only repository analysis tools are available.
- Fork PR handling uses base repository clone + PR ref fetch to avoid permission pitfalls.
- Shallow clone flow: `/tmp/harbor/{job_id}` with cleanup after each run.

## Local development

Prerequisites: Node.js 20+

```bash
# 1) install dependencies
bun install

# 2) env
cp .env.example .env

# 3) start both apps
bun run dev
```

- Web: `http://localhost:3000`
- API: `http://localhost:8787`
- Health: `GET http://localhost:8787/healthz`

`bun run dev` starts both `apps/web` and `apps/api` through turbo.

## Required environment variables

Refer to `.env.example`:

- `GITHUB_APP_ID`
- `GITHUB_PRIVATE_KEY_PEM` or `GITHUB_PRIVATE_KEY_PATH`
- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_REVIEW_TRIGGER_MENTION` (default: `@deniai-app`)
- `BASE_URL`
- `LLM_PROVIDER` (v1: `openai`)
- `LLM_MODEL` (for example: `gpt-5.2-codex`)
- `OPENAI_API_KEY`
- `VIRTUAL_IDE_ALLOW_CONFIG_READ` (default `false`)

## GitHub App setup

1. Create a GitHub App
2. Required permissions:
   - Pull requests: `Read & Write`
   - Contents: `Read`
   - Metadata: `Read`
3. Webhook URL:
   - `${BASE_URL}/webhooks/github`
4. Set webhook secret equal to `.env` `GITHUB_WEBHOOK_SECRET`
5. Subscribe to:
   - Pull request
   - Issue comment
   - Pull request review
   - Pull request review comment
6. Install the app to target repositories.

## Production deployment checklist

- Run behind HTTPS (reverse proxy or platform TLS termination).
- Store secrets in secure secret manager/CI variables; never commit private keys.
- Configure rate-limit and concurrency guards for webhook bursts.
- Use read-only service accounts for infrastructure dependencies where possible.
- Add request logging + structured output for each review run (`owner/repo#PR`, result, fallback count).
- Set up health checks and process restart policies in your orchestrator.
- Keep separate `canary` and `master` branches for staged promotion.

## Webhook test with curl

### 1) Generate payload

```bash
cat > /tmp/pr-opened.json <<'JSON'
{
  "action": "opened",
  "installation": { "id": 12345678 },
  "repository": {
    "name": "example-repo",
    "owner": { "login": "example-owner" }
  },
  "pull_request": {
    "number": 42,
    "head": {
      "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "repo": {
        "clone_url": "https://github.com/example-owner/example-repo.git"
      }
    }
  }
}
JSON
```

### 2) Create signature

```bash
secret='replace-with-strong-secret'
signature="sha256=$(openssl dgst -sha256 -hmac "$secret" /tmp/pr-opened.json | sed 's/^.* //')"
echo "$signature"
```

### 3) Send webhook

```bash
curl -i \
curl -X POST "http://localhost:8787/webhooks/github" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-Hub-Signature-256: ${signature}" \
  --data-binary @/tmp/pr-opened.json
```

## Virtual IDE tools (implemented)

- `list_dir(path='.', depth=3, max_entries=400)`
  - Required as the first tool call in prompt flow
  - Budget: max 3 calls per PR
- `get_changed_files()`
- `read_file(path, start_line, end_line)`
  - Only changed files, unless config-files override is enabled (`VIRTUAL_IDE_ALLOW_CONFIG_READ=true`)
  - 200 lines per call, total 2000 lines per PR
  - Budget: max 8 calls per PR
- `search_text(query, max_results=20)`
  - Budget: max 5 calls per PR

Exclusions and masking:

- Excluded directories: `.git`, `node_modules`, `dist`, `build`, `.next`, `coverage`, `.cache`, `.turbo`
- Hidden files: `.env*`, `*.pem`, `id_rsa`, `credentials*`

## Diff handling model

- Workdir: shallow clone `git clone --depth 1 --no-tags ...` into `/tmp/harbor/{job_id}`
- Fetch PR head by ref (`refs/pull/{number}/head`) when possible
- Cleanup after each run to keep disks safe and deterministic

## Constraints / notes

- Current LLM integration uses Vercel AI SDK (`ai` + `@ai-sdk/openai`) with interface separation.
- Suggestions that cannot be safely attached inline are summarized and posted as PR comments.
- Production hardening tasks:
  - Add more guardrails around context overflow
  - Expand language/edge-case tests for diff parser and tool budgets

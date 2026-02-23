# Deni AI Harbor — Product Overview

## What it does

Deni AI Harbor is an AI-assisted GitHub App for pull request review automation.

### Core behavior (v1)

1. Receive GitHub webhook events (`pull_request`, `issue_comment`, `pull_request_review`, `pull_request_review_comment`).
2. Validate webhook signatures (`X-Hub-Signature-256`) before processing.
3. Fetch PR changed files and patch data via GitHub API.
4. Parse diff lines and map inline `+` lines to patch positions.
5. Send safe, context-limited prompts to an LLM with **read-only** tools only.
6. Post inline ` ```suggestion``` ` comments where possible.
7. Auto-approve only in conservative mode when the review is considered fully safe.
8. Fall back to PR summary comment when inline comment placement is unsafe.

### Safety design

- LLM can read only repository context through virtual IDE tools.
- No file writes are performed by the model.
- Suggestion scope is constrained to changed lines.
- Fork PRs are handled by cloning base repository + PR ref fetch.
- Auto-approve requires explicit high-confidence status (conservative policy).

### Features (implemented)

- Webhook signature verification
- Diff-position calculation for inline comments
- Read-only tool calling:
  - `list_dir`
  - `get_changed_files`
  - `read_file`
  - `search_text`
- Conservative approval mode
- Fallback path for unattachable suggestions

## Local architecture

- **Web**: `/apps/web`
- **API**: `/apps/api`
- **Shared package**: `/packages/shared`

## Operational notes

- Uses shallow clones under `/tmp/harbor/{job_id}` and cleanup after each run.
- Keep separate branches for promotion (e.g., `canary` -> `master`).
- Configure webhook URL: `POST {BASE_URL}/webhooks/github` on your app.

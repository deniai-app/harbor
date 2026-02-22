# Deni AI Harbor (Prototype)

GitHub PR に対して `suggestion` 形式のレビューコメントを自動投稿するプロトタイプです。

- Web: `apps/web` (Next.js)
- API: `apps/api` (Hono, Node)
- Shared: `packages/shared`
- Deploy想定: Dokploy/Coolify 等の自前サーバー（Docker定義なし）

## できること (v1)

1. GitHub App webhook (`pull_request: opened/synchronize`, `issue_comment: created`, `pull_request_review: submitted/edited`, `pull_request_review_comment: created`) を受信
2. `X-Hub-Signature-256` を検証
3. installation token を発行して PR changed files を取得
4. patch の `+` 行に対応する diff `position` を計算
5. LLM (Vercel AI SDK + OpenAI provider) に read-only 仮想IDEツールを function calling で提供
6. `POST /pulls/{pull_number}/reviews` で inline suggestion コメントを投稿（`issue_comment` / `pull_request_review` / `pull_request_review_comment` は `@deniai-app` メンション時のみ実行）
7. 指摘が無く、かつ総合レビュー（正しさ・セキュリティ・性能・保守性）が高信頼で完了した場合のみ `APPROVE` レビューを投稿
8. patch が欠落するファイルは PR 全体コメントへフォールバック

## リポジトリ構成

```text
/apps/web
/apps/api
/packages/shared
```

## ローカル起動

前提: Node.js 20+

```bash
# 1) install
bun install

# 2) env
cp .env.example .env

# 3) start both web + api
bun run dev
```

- Web: `http://localhost:3000`
- API: `http://localhost:8787`
- Health: `GET http://localhost:8787/healthz`

`bun run dev` は turbo で `apps/web` と `apps/api` を同時起動します。

## 必要な環境変数

`.env.example` を参照:

- `GITHUB_APP_ID`
- `GITHUB_PRIVATE_KEY_PEM` または `GITHUB_PRIVATE_KEY_PATH`
- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_REVIEW_TRIGGER_MENTION` (default: `@deniai-app`)
- `BASE_URL`
- `LLM_PROVIDER` (v1: `openai`)
- `LLM_MODEL` (例: `gpt-5.2-codex`)
- `OPENAI_API_KEY`
- `VIRTUAL_IDE_ALLOW_CONFIG_READ` (default `false`)

## GitHub App 設定

1. GitHubで App を作成
2. Permissions:
   - Pull requests: `Read & Write`
   - Contents: `Read`
   - Metadata: `Read` (通常デフォルト)
3. Webhook URL:
   - `${BASE_URL}/webhooks/github`
4. Webhook secret:
   - `.env` の `GITHUB_WEBHOOK_SECRET` と同値
5. Subscribe to events:
   - `Pull request`
   - `Issue comment`
   - `Pull request review`
   - `Pull request review comment`
6. App を対象リポジトリへインストール

## Webhook テスト (curl)

### 1) ペイロード作成

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

### 2) 署名を生成

```bash
secret='replace-with-strong-secret'
signature="sha256=$(openssl dgst -sha256 -hmac "$secret" /tmp/pr-opened.json | sed 's/^.* //')"
echo "$signature"
```

### 3) webhookへ送信

```bash
curl -i \
  -X POST "http://localhost:8787/webhooks/github" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-Hub-Signature-256: ${signature}" \
  --data-binary @/tmp/pr-opened.json
```

## 仮想IDEツール仕様 (実装済み)

- `list_dir(path='.', depth=3, max_entries=400)`
  - 初回ツール呼び出しは必須
  - 予算: PRあたり最大3回
- `get_changed_files()`
- `read_file(path, start_line, end_line)`
  - 変更ファイルのみ読める（設定ファイル例外は `VIRTUAL_IDE_ALLOW_CONFIG_READ=true` で有効化）
  - 1回200行、PR合計2000行
  - 予算: PRあたり最大8回
- `search_text(query, max_results=20)`
  - 予算: PRあたり最大5回

除外・秘匿:

- 除外ディレクトリ: `.git`, `node_modules`, `dist`, `build`, `.next`, `coverage`, `.cache`, `.turbo`
- 非表示ファイル: `.env*`, `*.pem`, `id_rsa`, `credentials*`

## shallow clone 方針

- 作業ディレクトリ: `/tmp/harbor/{job_id}`
- clone: `git clone --depth 1 --no-tags ...`
- 必要時のみ `head_sha` を fetch/checkout
- 処理後に毎回削除

## 制約/TODO (v1)

- LLM 実装は Vercel AI SDK (`ai` + `@ai-sdk/openai`) のみ（インターフェースは分離済み）
- patch 位置が確定できない提案は PR 全体コメントに退避
- テストコードは未追加（次段で diff parser / tool budget の単体テスト推奨）

# Codex Task Prompt: Deni AI Harbor Improvement (API)

## 役割
あなたは Deni AI Harbor のシニアリリース準備エンジニアです。以下の不具合・不安定要素を最優先で改善してください。

## 背景
- リポジトリ: `https://github.com/deniai-app/harbor`
- アーキテクチャ: monorepo
  - `apps/api` (Hono backend)
  - `apps/web` (Next.js)
- 目的: PRサジェストbot。提案ベースのレビューを行い、必要なら Safeモード自動承認。
- 前提: LLMは読み取り専用ツールでdiff上のみ提案。

## 改善したい問題（優先順）

### 1) fork PR への対応を壊さない clone/checkout
現在、`createWorkdirSession` に `head.repo.clone_url` を使ってHEADを取得しようとしている。fork PR でクローン先権限不足になる可能性がある。

- 変更対象
  - `apps/api/src/workers/process-pr.ts`
  - `apps/api/src/git/workdir.ts`

- 対応方針（推奨）
  1. クローンは PR が出されている**ベースリポジトリ**（`owner/repo`）を使う。
  2. `git fetch origin +refs/pull/<PR_NUMBER>/head:refs/pull/<PR_NUMBER>/head` を実行し、
     `git checkout --detach refs/pull/<PR_NUMBER>/head`。
  3. `createWorkdirSession` のAPIは `cloneUrl` 依存を緩和し、`repoOwner/repo` から `cloneUrl` を組み立てるか、`repository.clone_url` を明示的に渡す。
  4. `clone_url` が空/取得不可でも破綻しない防御を入れる。

- 実装上の注意
  - 既存挙動を壊さないように、最小差分で。
  - 取得不能時は明確なエラーログを出して `review run` 失敗扱い。

---

### 2) Auto-approve 条件の強化
現在は `overallComment === "REVIEW_OK..."` 文字列一致 + suggestions 空 で承認している。

- 変更対象
  - `apps/api/src/workers/process-pr.ts`
  - `apps/api/src/llm/openai-provider.ts`
  - `apps/api/src/llm/types.ts`

- 目標
  - **LLM出力に安全状態を明示**（例: `overallStatus: "ok" | "uncertain"` のようなフラグ）を含める。
  - `APPROVE` は次を同時満たすときだけ
    - `overallStatus === "ok"`
    - `suggestions.length === 0`
    - `overallComment` が完全一致許容される安全文字列か、明示キーで許可された時のみ
  - 不確実なら絶対に `APPROVE` しない（最低コメントだけ）。

- 検討点
  - APIレスポンス互換性: 既存 `overallComment` は残す。
  - `overallStatus` が欠ける古いレスポンスでも後方互換で `no_approve` 側に倒す。

---

### 3) Mention 判定を厳密化
`containsMention` が生の `includes` で甘い。

- 変更対象
  - `apps/api/src/workers/process-pr.ts`

- 実装要件
  - 本文の `@username` のメンションを、
    - 大文字小文字を吸収
    - 句読点・HTML（`<...>`）前後でも誤反応しにくく
    - GitHubが使う `<@USERID>` 形式にも対応
  - 正規化後に厳密一致。

---

### 4) Inline付与に失敗した候補の扱いをノイズ抑制
`buildFallbackSection` が本文に `body` 全文を貼るとノイズになる。

- 変更対象
  - `apps/api/src/workers/process-pr.ts`

- 対応
  - fallbackは `path:line` と簡潔な理由に留める（全文貼りしない）。
  - 本文は「適用できなかった提案件数のみ」簡潔に。

---

### 5) 位置マップ/パッチ解析テストを追加
`buildAddedLineToPositionMap` と `extractPatchByFile` は重要。

- 変更対象
  - `apps/api/src/diff/patch.ts`
  - テスト追加（既存テスト構成がない場合は簡易Vitest追加でも可）

- カバーケース
  - 通常の追加/削除/コンテキスト行
  - 2+ hunk
  - 末尾が `\ No newline at end of file`
  - patch無し（`@@`なし）
  - 既存行番号と追加行番号の照合

---

## 受け入れ条件（必須）

- `bun run --filter api build` が通る
- `bun run --filter web build` が通る（変更がAPIのみでも必須）
- 主要フローの変更は最小かつ明示的コメント付き
- fork PR の `head`/`base` 差分を意識したテストシナリオを想定していること
- 自動承認の判定は「保守的」を最優先（誤承認ゼロ優先）

## 制約
- 既存APIや環境変数を壊さない（後方互換）
- 破壊的変更（LLMプロバイダのI/F全面差し替え）はしない
- まず `apps/api` を優先して、`apps/web` は必要な場合のみ触る

## 期待する実装差分（提出形式）
- 各対象ファイルの変更点だけを含める
- 重要な判断ポイントはコメントに残す
- 変更理由とリスクを短く整理してPR向け説明文を最後に添える

---

## 参考: 主要箇所（現状）
- `apps/api/src/git/workdir.ts`
- `apps/api/src/workers/process-pr.ts`
- `apps/api/src/llm/openai-provider.ts`
- `apps/api/src/llm/types.ts`
- `apps/api/src/diff/patch.ts`

---

このプロンプトをそのままコピペして Codex に渡してOK。
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfigFromEnv } from "./config/env";
import { GitHubInstallationAuth } from "./github/auth";
import { createLlmProvider } from "./llm/factory";
import { verifyGitHubSignature } from "./security/signature";
import {
  processIssueCommentEvent,
  processPullRequestEvent,
  processPullRequestReviewEvent,
  processPullRequestReviewCommentEvent,
} from "./workers/process-pr";

async function bootstrap() {
  const config = await loadConfigFromEnv();

  const auth = new GitHubInstallationAuth(config.github.appId, config.github.privateKey);

  let llmProvider = null;
  const reviewModel =
    config.llm.modelByProfile?.[config.reviewProfile] ??
    config.llm.model ??
    "gpt-5.3-codex";

  try {
    llmProvider = createLlmProvider({
      provider: config.llm.provider,
      model: reviewModel,
      openaiApiKey: config.llm.openaiApiKey,
    });
  } catch (error) {
    console.error("Failed to initialize LLM provider. Reviews will be skipped.", error);
  }

  const app = new Hono();

  app.get("/", (c) => {
    return c.json({
      service: "deni-ai-harbor-api",
      status: "ok",
      baseUrl: config.baseUrl,
    });
  });

  app.get("/healthz", (c) => {
    return c.json({ ok: true });
  });

  app.post("/webhooks/github", async (c) => {
    const signature = c.req.header("x-hub-signature-256");
    const event = c.req.header("x-github-event");
    const rawBody = await c.req.text();

    const isValid = verifyGitHubSignature(rawBody, config.github.webhookSecret, signature);
    if (!isValid) {
      return c.json({ ok: false, error: "invalid signature" }, 401);
    }

    if (
      event !== "pull_request" &&
      event !== "issue_comment" &&
      event !== "pull_request_review_comment" &&
      event !== "pull_request_review"
    ) {
      console.info(`[webhook] Ignored event=${event ?? "unknown"}`);
      return c.json({ ok: true, ignored: true });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ ok: false, error: "invalid JSON payload" }, 400);
    }

    const deps = {
      auth,
      llmProvider,
      reviewProfile: config.reviewProfile,
      allowConfigRead: config.virtualIde.allowConfigRead,
      triggerMention: config.github.reviewTriggerMention,
    };

    let task: Promise<void>;
    switch (event) {
      case "pull_request":
        task = processPullRequestEvent(payload as never, deps);
        break;
      case "issue_comment":
        task = processIssueCommentEvent(payload as never, deps);
        break;
      case "pull_request_review":
        task = processPullRequestReviewEvent(payload as never, deps);
        break;
      default:
        task = processPullRequestReviewCommentEvent(payload as never, deps);
        break;
    }

    console.info(`[webhook] Accepted event=${event}`);

    void task.catch((error: unknown) => {
      console.error("Failed to process webhook", error);
    });

    return c.json({ ok: true, queued: true }, 202);
  });

  const port = config.port;
  serve({ fetch: app.fetch, port });
  console.info(`API started on http://localhost:${port}`);
}

void bootstrap().catch((error) => {
  console.error("Failed to start API", error);
  process.exit(1);
});

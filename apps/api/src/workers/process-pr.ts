import type { GitHubPullRequestFile, SuggestionCandidate } from "@workspace/shared";
import { buildAddedLineToPositionMap, extractPatchByFile } from "../diff/patch";
import { createWorkdirSession } from "../git/workdir";
import {
  createIssueComment,
  createIssueCommentReaction,
  createPullRequestReview,
  createPullRequestReviewCommentReaction,
  getPullRequestDiff,
  getPullRequestFiles,
  getPullRequestHead,
  updateIssueComment,
  type ReviewCommentInput,
} from "../github/client";
import type { GitHubInstallationAuth } from "../github/auth";
import type { ReviewLlmProvider } from "../llm/types";
import { VirtualIdeTools } from "../virtual-ide/context";

interface PullRequestWebhookPayload {
  action: string;
  installation?: {
    id: number;
  };
  repository: {
    name: string;
    owner: {
      login: string;
    };
  };
  pull_request: {
    number: number;
    head: {
      sha: string;
      repo: {
        clone_url: string;
      };
    };
  };
}

interface IssueCommentWebhookPayload {
  action: string;
  installation?: {
    id: number;
  };
  repository: {
    name: string;
    owner: {
      login: string;
    };
  };
  issue: {
    number: number;
    pull_request?: Record<string, unknown>;
  };
  comment: {
    id: number;
    body: string;
  };
}

interface PullRequestReviewCommentWebhookPayload {
  action: string;
  installation?: {
    id: number;
  };
  repository: {
    name: string;
    owner: {
      login: string;
    };
  };
  pull_request: {
    number: number;
  };
  comment: {
    id: number;
    body: string;
  };
}

interface PullRequestReviewWebhookPayload {
  action: string;
  installation?: {
    id: number;
  };
  repository: {
    name: string;
    owner: {
      login: string;
    };
  };
  pull_request: {
    number: number;
  };
  review: {
    id: number;
    body?: string | null;
  };
}

interface ReviewRequestInput {
  installationId: number;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha?: string;
  cloneUrl?: string;
  token?: string;
}

interface ProcessPullRequestEventDeps {
  auth: GitHubInstallationAuth;
  llmProvider: ReviewLlmProvider | null;
  allowConfigRead: boolean;
  triggerMention: string;
}

interface ReviewRunOutcome {
  status: "posted" | "approved" | "no_suggestions" | "skipped_no_llm";
  inlineCommentCount: number;
  hasSummaryBody: boolean;
}

function isTargetAction(action: string): action is "opened" | "synchronize" {
  return action === "opened" || action === "synchronize";
}

function isCommentCreatedAction(action: string): action is "created" {
  return action === "created";
}

function isPullRequestReviewAction(action: string): action is "submitted" | "edited" {
  return action === "submitted" || action === "edited";
}

function containsMention(body: string, mention: string): boolean {
  const trimmedMention = mention.trim();
  if (trimmedMention.length === 0) {
    return false;
  }

  return body.toLowerCase().includes(trimmedMention.toLowerCase());
}

function isDeniAiSystemComment(body: string): boolean {
  return body.includes("<!-- deniai:reviewing:start -->") || body.includes("<!-- deniai:reviewing:end -->");
}

async function notifyMentionTriggered(params: {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
  source: "issue_comment" | "pull_request" | "pull_request_review_comment" | "pull_request_review";
  commentId: number;
  llmProvider: ReviewLlmProvider | null;
}): Promise<number | undefined> {
  try {
    if (params.source === "issue_comment") {
      await createIssueCommentReaction({
        token: params.token,
        owner: params.owner,
        repo: params.repo,
        commentId: params.commentId,
      });
    } else if (params.source === "pull_request_review_comment") {
      await createPullRequestReviewCommentReaction({
        token: params.token,
        owner: params.owner,
        repo: params.repo,
        commentId: params.commentId,
      });
    } else {
      // GitHub does not expose a stable reaction API for review summaries in this flow.
      console.info(
        `[mention-trigger] Skip reaction for ${params.owner}/${params.repo}#${params.pullNumber} (${params.source}:${params.commentId})`,
      );
    }
    if (params.source !== "pull_request_review") {
      console.info(
        `[mention-trigger] Added eyes reaction on ${params.owner}/${params.repo}#${params.pullNumber} (${params.source}:${params.commentId})`,
      );
    }
  } catch (error) {
    console.warn("[mention-trigger] Failed to add eyes reaction", error);
  }

  const reviewingBody = await buildReviewingComment({
    owner: params.owner,
    repo: params.repo,
    pullNumber: params.pullNumber,
    source: params.source,
    llmProvider: params.llmProvider,
  });

  try {
    const progressCommentId = await createIssueComment({
      token: params.token,
      owner: params.owner,
      repo: params.repo,
      issueNumber: params.pullNumber,
      body: reviewingBody,
    });
    console.info(
      `[mention-trigger] Posted reviewing comment on ${params.owner}/${params.repo}#${params.pullNumber} (comment_id=${progressCommentId})`,
    );
    return progressCommentId;
  } catch (error) {
    console.warn("[mention-trigger] Failed to post reviewing comment", error);
    return undefined;
  }
}

async function buildReviewingComment(params: {
  owner: string;
  repo: string;
  pullNumber: number;
  source: "issue_comment" | "pull_request" | "pull_request_review_comment" | "pull_request_review";
  llmProvider: ReviewLlmProvider | null;
}): Promise<string> {
  let coreBody = buildDefaultReviewingCommentCore({
    owner: params.owner,
    repo: params.repo,
    pullNumber: params.pullNumber,
  });

  if (params.llmProvider) {
    try {
      const aiBody = await params.llmProvider.generateReviewingComment({
        owner: params.owner,
        repo: params.repo,
        pullNumber: params.pullNumber,
        source: params.source,
      });
      if (aiBody && aiBody.trim().length > 0) {
        coreBody = aiBody.trim();
      }
    } catch (error) {
      console.warn("[mention-trigger] Failed to generate AI reviewing comment. Falling back to template.", error);
    }
  }

  return [
    "<!-- deniai:reviewing:start -->",
    "<!-- auto-generated by deni-ai-harbor -->",
    "",
    "## Harbor is working...",
    "",
    coreBody,
    "",
    "<!-- deniai:reviewing:end -->",
  ].join("\n");
}

function buildDefaultReviewingCommentCore(params: {
  owner: string;
  repo: string;
  pullNumber: number;
}): string {
  return [
    `Triggered on ${params.owner}/${params.repo}#${params.pullNumber}.`,
    "",
    "<details>",
    "<summary>Walkthrough (building)</summary>",
    "",
    "### Current status",
    "- Collecting changed files and patches",
    "- Analyzing risk and edge cases",
    "- Preparing inline suggestions",
    "",
    "### What to expect",
    "- Inline suggestion comments on diff lines when applicable",
    "- A top-level summary comment in the final review",
    "",
    "</details>",
    "",
    "_Reviewing now. Final output will be posted shortly._",
  ].join("\n");
}

function buildCompletedReviewingComment(params: {
  owner: string;
  repo: string;
  pullNumber: number;
  startedAt: number;
  finishedAt: number;
  outcome?: ReviewRunOutcome;
  error?: unknown;
}): string {
  const elapsedSeconds = Math.max(1, Math.round((params.finishedAt - params.startedAt) / 1000));
  const statusLine = params.error ? "## Harbor finished work (with errors)" : "## Harbor finished work";

  let resultSummary = "- Result: review execution ended.";
  if (params.error) {
    resultSummary = `- Result: failed (${String((params.error as Error)?.message ?? params.error)})`;
  } else if (params.outcome?.status === "posted") {
    resultSummary = `- Result: posted review (${params.outcome.inlineCommentCount} inline comments).`;
  } else if (params.outcome?.status === "no_suggestions") {
    resultSummary = "- Result: no safe suggestions were found.";
  } else if (params.outcome?.status === "approved") {
    resultSummary = "- Result: approved (no actionable issues found).";
  } else if (params.outcome?.status === "skipped_no_llm") {
    resultSummary = "- Result: skipped because LLM provider is unavailable.";
  }

  const bodySummary = params.outcome?.hasSummaryBody ? "- Top-level review summary: included." : "- Top-level review summary: none.";

  return [
    "<!-- deniai:reviewing:start -->",
    "<!-- auto-generated by deni-ai-harbor -->",
    "",
    statusLine,
    "",
    `For ${params.owner}/${params.repo}#${params.pullNumber}.`,
    "",
    "<details>",
    "<summary>Review execution summary</summary>",
    "",
    "### Outcome",
    resultSummary,
    bodySummary,
    `- Duration: ~${elapsedSeconds}s`,
    "",
    "</details>",
    "",
    "_This status comment has been finalized._",
    "",
    "<!-- deniai:reviewing:end -->",
  ].join("\n");
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replaceAll("\\", "/");
}

function buildFallbackSection(items: SuggestionCandidate[]): string {
  const lines = [
    "Some suggestions could not be attached inline (missing/ambiguous diff position):",
  ];

  for (const item of items) {
    lines.push(`\n${item.path}:${item.line}`);
    lines.push(item.body);
  }

  return lines.join("\n").trim();
}

function buildReviewPayload(params: {
  suggestions: SuggestionCandidate[];
  overallComment?: string;
  files: GitHubPullRequestFile[];
}): { comments: ReviewCommentInput[]; body?: string } | null {
  const fileMap = new Map(params.files.map((file) => [file.filename, file]));
  const comments: ReviewCommentInput[] = [];
  const fallbackItems: SuggestionCandidate[] = [];
  const seen = new Set<string>();

  for (const suggestion of params.suggestions) {
    const path = normalizePath(suggestion.path);
    const file = fileMap.get(path);

    if (!file || !file.patch) {
      fallbackItems.push({ ...suggestion, path });
      continue;
    }

    const positionMap = buildAddedLineToPositionMap(file.patch);
    const position = positionMap.get(suggestion.line);

    if (!position) {
      fallbackItems.push({ ...suggestion, path });
      continue;
    }

    const key = `${path}:${position}:${suggestion.body}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    comments.push({
      path,
      position,
      body: suggestion.body,
    });

    if (comments.length >= 20) {
      break;
    }
  }

  const bodyParts: string[] = [];
  if (params.overallComment && params.overallComment.trim().length > 0) {
    bodyParts.push(params.overallComment.trim());
  }
  if (fallbackItems.length > 0) {
    bodyParts.push(buildFallbackSection(fallbackItems));
  }
  if (bodyParts.length === 0 && comments.length > 0) {
    bodyParts.push("Automated review comments from @deniai-app.");
  }

  const body = bodyParts.join("\n\n").trim() || undefined;

  if (comments.length === 0 && !body) {
    return null;
  }

  return {
    comments,
    body,
  };
}

async function enrichMissingPatches(params: {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
  files: GitHubPullRequestFile[];
}): Promise<GitHubPullRequestFile[]> {
  if (params.files.every((file) => Boolean(file.patch))) {
    return params.files;
  }

  const diffText = await getPullRequestDiff({
    token: params.token,
    owner: params.owner,
    repo: params.repo,
    pullNumber: params.pullNumber,
  });

  const patchMap = extractPatchByFile(diffText);

  return params.files.map((file) => {
    if (file.patch) {
      return file;
    }

    const patch = patchMap.get(file.filename);
    if (!patch) {
      return file;
    }

    return {
      ...file,
      patch,
    };
  });
}

async function runReviewForPullRequest(
  params: ReviewRequestInput,
  deps: ProcessPullRequestEventDeps,
): Promise<ReviewRunOutcome> {
  if (!deps.llmProvider) {
    console.warn("LLM provider is unavailable. Skipping automated suggestions.");
    return {
      status: "skipped_no_llm",
      inlineCommentCount: 0,
      hasSummaryBody: false,
    };
  }

  const token = params.token ?? (await deps.auth.getInstallationToken(params.installationId));
  console.info(`[review] Start review for ${params.owner}/${params.repo}#${params.pullNumber}`);

  let headSha = params.headSha;
  let cloneUrl = params.cloneUrl;
  if (!headSha || !cloneUrl) {
    const head = await getPullRequestHead({
      token,
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
    });
    headSha = head.headSha;
    cloneUrl = head.cloneUrl;
  }

  const files = await getPullRequestFiles({
    token,
    owner: params.owner,
    repo: params.repo,
    pullNumber: params.pullNumber,
  });

  const mergedFiles = await enrichMissingPatches({
    token,
    owner: params.owner,
    repo: params.repo,
    pullNumber: params.pullNumber,
    files,
  });

  const workdirSession = await createWorkdirSession({
    cloneUrl,
    token,
    headSha,
  });

  try {
    const virtualIdeTools = new VirtualIdeTools({
      rootDir: workdirSession.workdir,
      changedFiles: mergedFiles,
      allowConfigRead: deps.allowConfigRead,
    });

    const llmResult = await deps.llmProvider.generateSuggestions({
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
      headSha,
      changedFiles: mergedFiles,
      virtualIdeTools,
    });
    console.info(`[review] LLM produced ${llmResult.suggestions.length} suggestion candidates for ${params.owner}/${params.repo}#${params.pullNumber}`);

    const explicitReviewOk = llmResult.overallComment?.trim() === "REVIEW_OK: No actionable issues found in changed lines.";
    const canApprove = llmResult.suggestions.length === 0 && explicitReviewOk;

    if (canApprove) {
      const approvalBody = llmResult.overallComment?.trim() || "REVIEW_OK: No actionable issues found in changed lines.";
      await createPullRequestReview({
        token,
        owner: params.owner,
        repo: params.repo,
        pullNumber: params.pullNumber,
        event: "APPROVE",
        body: approvalBody,
      });
      console.info(`[review] Approved ${params.owner}/${params.repo}#${params.pullNumber} (no actionable issues).`);
      return {
        status: "approved",
        inlineCommentCount: 0,
        hasSummaryBody: true,
      };
    }

    const reviewPayload = buildReviewPayload({
      suggestions: llmResult.suggestions,
      overallComment: llmResult.overallComment,
      files: mergedFiles,
    });

    if (!reviewPayload) {
      console.info(`[review] No safe suggestions for ${params.owner}/${params.repo}#${params.pullNumber}`);
      return {
        status: "no_suggestions",
        inlineCommentCount: 0,
        hasSummaryBody: false,
      };
    }

    await createPullRequestReview({
      token,
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
      body: reviewPayload.body,
      comments: reviewPayload.comments,
    });

    console.info(
      `[review] Posted review to ${params.owner}/${params.repo}#${params.pullNumber} with ${reviewPayload.comments.length} inline comments.`,
    );
    return {
      status: "posted",
      inlineCommentCount: reviewPayload.comments.length,
      hasSummaryBody: Boolean(reviewPayload.body),
    };
  } finally {
    await workdirSession.cleanup();
    console.info(`[review] Finished review for ${params.owner}/${params.repo}#${params.pullNumber}`);
  }
}

export async function processPullRequestEvent(
  payload: PullRequestWebhookPayload,
  deps: ProcessPullRequestEventDeps,
): Promise<void> {
  if (!isTargetAction(payload.action)) {
    console.info(`[pull_request] Ignore action=${payload.action}`);
    return;
  }

  const installationId = payload.installation?.id;
  if (!installationId) {
    throw new Error("Missing installation id in webhook payload.");
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pullNumber = payload.pull_request.number;
  const startedAt = Date.now();

  console.info(`[pull_request] Trigger review for ${owner}/${repo}#${pullNumber} action=${payload.action}`);

  const token = await deps.auth.getInstallationToken(installationId);

  let progressCommentId: number | undefined;
  try {
    const reviewingBody = await buildReviewingComment({
      owner,
      repo,
      pullNumber,
      source: "pull_request",
      llmProvider: deps.llmProvider,
    });
    progressCommentId = await createIssueComment({
      token,
      owner,
      repo,
      issueNumber: pullNumber,
      body: reviewingBody,
    });
    console.info(`[pull_request] Posted reviewing comment ${progressCommentId} on ${owner}/${repo}#${pullNumber}`);
  } catch (error) {
    console.warn("[pull_request] Failed to post reviewing comment", error);
  }

  let outcome: ReviewRunOutcome | undefined;
  let reviewError: unknown;
  try {
    outcome = await runReviewForPullRequest(
      {
        installationId,
        owner,
        repo,
        pullNumber,
        headSha: payload.pull_request.head.sha,
        cloneUrl: payload.pull_request.head.repo.clone_url,
        token,
      },
      deps,
    );
  } catch (error) {
    reviewError = error;
  }

  if (progressCommentId) {
    try {
      await updateIssueComment({
        token,
        owner,
        repo,
        commentId: progressCommentId,
        body: buildCompletedReviewingComment({
          owner,
          repo,
          pullNumber,
          startedAt,
          finishedAt: Date.now(),
          outcome,
          error: reviewError,
        }),
      });
      console.info(`[pull_request] Finalized reviewing comment ${progressCommentId} on ${owner}/${repo}#${pullNumber}`);
    } catch (error) {
      console.warn("[pull_request] Failed to finalize reviewing comment", error);
    }
  }

  if (reviewError) {
    throw reviewError;
  }
}

export async function processIssueCommentEvent(
  payload: IssueCommentWebhookPayload,
  deps: ProcessPullRequestEventDeps,
): Promise<void> {
  if (!isCommentCreatedAction(payload.action)) {
    console.info(`[issue_comment] Ignore action=${payload.action}`);
    return;
  }

  if (!payload.issue.pull_request) {
    console.info(
      `[issue_comment] Ignore non-PR issue for ${payload.repository.owner.login}/${payload.repository.name}#${payload.issue.number}`,
    );
    return;
  }

  if (isDeniAiSystemComment(payload.comment.body)) {
    console.info(
      `[issue_comment] Ignore deni-ai system comment for ${payload.repository.owner.login}/${payload.repository.name}#${payload.issue.number}`,
    );
    return;
  }

  if (!containsMention(payload.comment.body, deps.triggerMention)) {
    console.info(
      `[issue_comment] Mention not found in ${payload.repository.owner.login}/${payload.repository.name}#${payload.issue.number}`,
    );
    return;
  }

  const installationId = payload.installation?.id;
  if (!installationId) {
    throw new Error("Missing installation id in webhook payload.");
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pullNumber = payload.issue.number;
  const startedAt = Date.now();

  console.info(`[issue_comment] Mention detected. Trigger review for ${owner}/${repo}#${pullNumber}`);
  const token = await deps.auth.getInstallationToken(installationId);

  const progressCommentId = await notifyMentionTriggered({
    token,
    owner,
    repo,
    pullNumber,
    source: "issue_comment",
    commentId: payload.comment.id,
    llmProvider: deps.llmProvider,
  });

  let outcome: ReviewRunOutcome | undefined;
  let reviewError: unknown;
  try {
    outcome = await runReviewForPullRequest(
      {
        installationId,
        owner,
        repo,
        pullNumber,
        token,
      },
      deps,
    );
  } catch (error) {
    reviewError = error;
  }

  if (progressCommentId) {
    try {
      await updateIssueComment({
        token,
        owner,
        repo,
        commentId: progressCommentId,
        body: buildCompletedReviewingComment({
          owner,
          repo,
          pullNumber,
          startedAt,
          finishedAt: Date.now(),
          outcome,
          error: reviewError,
        }),
      });
      console.info(`[mention-trigger] Finalized reviewing comment ${progressCommentId} on ${owner}/${repo}#${pullNumber}`);
    } catch (error) {
      console.warn("[mention-trigger] Failed to finalize reviewing comment", error);
    }
  }

  if (reviewError) {
    throw reviewError;
  }
}

export async function processPullRequestReviewEvent(
  payload: PullRequestReviewWebhookPayload,
  deps: ProcessPullRequestEventDeps,
): Promise<void> {
  if (!isPullRequestReviewAction(payload.action)) {
    console.info(`[pull_request_review] Ignore action=${payload.action}`);
    return;
  }

  const reviewBody = payload.review.body ?? "";
  if (isDeniAiSystemComment(reviewBody)) {
    console.info(
      `[pull_request_review] Ignore deni-ai system review body for ${payload.repository.owner.login}/${payload.repository.name}#${payload.pull_request.number}`,
    );
    return;
  }

  if (!containsMention(reviewBody, deps.triggerMention)) {
    console.info(
      `[pull_request_review] Mention not found in ${payload.repository.owner.login}/${payload.repository.name}#${payload.pull_request.number}`,
    );
    return;
  }

  const installationId = payload.installation?.id;
  if (!installationId) {
    throw new Error("Missing installation id in webhook payload.");
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pullNumber = payload.pull_request.number;
  const startedAt = Date.now();

  console.info(`[pull_request_review] Mention detected. Trigger review for ${owner}/${repo}#${pullNumber}`);
  const token = await deps.auth.getInstallationToken(installationId);

  const progressCommentId = await notifyMentionTriggered({
    token,
    owner,
    repo,
    pullNumber,
    source: "pull_request_review",
    commentId: payload.review.id,
    llmProvider: deps.llmProvider,
  });

  let outcome: ReviewRunOutcome | undefined;
  let reviewError: unknown;
  try {
    outcome = await runReviewForPullRequest(
      {
        installationId,
        owner,
        repo,
        pullNumber,
        token,
      },
      deps,
    );
  } catch (error) {
    reviewError = error;
  }

  if (progressCommentId) {
    try {
      await updateIssueComment({
        token,
        owner,
        repo,
        commentId: progressCommentId,
        body: buildCompletedReviewingComment({
          owner,
          repo,
          pullNumber,
          startedAt,
          finishedAt: Date.now(),
          outcome,
          error: reviewError,
        }),
      });
      console.info(`[mention-trigger] Finalized reviewing comment ${progressCommentId} on ${owner}/${repo}#${pullNumber}`);
    } catch (error) {
      console.warn("[mention-trigger] Failed to finalize reviewing comment", error);
    }
  }

  if (reviewError) {
    throw reviewError;
  }
}

export async function processPullRequestReviewCommentEvent(
  payload: PullRequestReviewCommentWebhookPayload,
  deps: ProcessPullRequestEventDeps,
): Promise<void> {
  if (!isCommentCreatedAction(payload.action)) {
    console.info(`[pull_request_review_comment] Ignore action=${payload.action}`);
    return;
  }

  if (!containsMention(payload.comment.body, deps.triggerMention)) {
    console.info(
      `[pull_request_review_comment] Mention not found in ${payload.repository.owner.login}/${payload.repository.name}#${payload.pull_request.number}`,
    );
    return;
  }

  if (isDeniAiSystemComment(payload.comment.body)) {
    console.info(
      `[pull_request_review_comment] Ignore deni-ai system comment for ${payload.repository.owner.login}/${payload.repository.name}#${payload.pull_request.number}`,
    );
    return;
  }

  const installationId = payload.installation?.id;
  if (!installationId) {
    throw new Error("Missing installation id in webhook payload.");
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pullNumber = payload.pull_request.number;
  const startedAt = Date.now();

  console.info(`[pull_request_review_comment] Mention detected. Trigger review for ${owner}/${repo}#${pullNumber}`);
  const token = await deps.auth.getInstallationToken(installationId);

  const progressCommentId = await notifyMentionTriggered({
    token,
    owner,
    repo,
    pullNumber,
    source: "pull_request_review_comment",
    commentId: payload.comment.id,
    llmProvider: deps.llmProvider,
  });

  let outcome: ReviewRunOutcome | undefined;
  let reviewError: unknown;
  try {
    outcome = await runReviewForPullRequest(
      {
        installationId,
        owner,
        repo,
        pullNumber,
        token,
      },
      deps,
    );
  } catch (error) {
    reviewError = error;
  }

  if (progressCommentId) {
    try {
      await updateIssueComment({
        token,
        owner,
        repo,
        commentId: progressCommentId,
        body: buildCompletedReviewingComment({
          owner,
          repo,
          pullNumber,
          startedAt,
          finishedAt: Date.now(),
          outcome,
          error: reviewError,
        }),
      });
      console.info(
        `[mention-trigger] Finalized reviewing comment ${progressCommentId} on ${owner}/${repo}#${pullNumber}`,
      );
    } catch (error) {
      console.warn("[mention-trigger] Failed to finalize reviewing comment", error);
    }
  }

  if (reviewError) {
    throw reviewError;
  }
}

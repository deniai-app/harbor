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
  listIssueComments,
  updateIssueComment,
  type ReviewCommentInput,
} from "../github/client";
import type { GitHubInstallationAuth } from "../github/auth";
import { REVIEW_OK_COMMENT, type ReviewLlmProvider } from "../llm/types";
import { VirtualIdeTools } from "../virtual-ide/context";

interface PullRequestWebhookPayload {
  action: string;
  installation?: {
    id: number;
  };
  repository: {
    name: string;
    clone_url?: string;
    owner: {
      login: string;
    };
  };
  pull_request: {
    number: number;
    head: {
      sha: string;
      repo: {
        clone_url?: string;
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

const GITHUB_USER_ID_MENTION_PATTERN = /<@([a-z0-9_-]+)>/gi;
const GITHUB_USERNAME_MENTION_PATTERN = /(^|[^a-z0-9-])@([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)(?=[^a-z0-9-]|$)/gi;

interface MentionTarget {
  kind: "user_id" | "username";
  value: string;
}

function parseMentionTarget(rawMention: string): MentionTarget | null {
  const trimmedMention = rawMention.trim();
  if (trimmedMention.length === 0) {
    return null;
  }

  const userIdMatch = /^<@([a-z0-9_-]+)>$/i.exec(trimmedMention);
  if (userIdMatch?.[1]) {
    return {
      kind: "user_id",
      value: userIdMatch[1].toLowerCase(),
    };
  }

  const normalizedUsername = trimmedMention.replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(normalizedUsername)) {
    return null;
  }

  return {
    kind: "username",
    value: normalizedUsername,
  };
}

function extractMentionCandidates(body: string): { usernames: Set<string>; userIds: Set<string> } {
  const usernames = new Set<string>();
  const userIds = new Set<string>();

  for (const match of body.matchAll(GITHUB_USER_ID_MENTION_PATTERN)) {
    const id = match[1];
    if (id) {
      userIds.add(id.toLowerCase());
    }
  }

  for (const match of body.matchAll(GITHUB_USERNAME_MENTION_PATTERN)) {
    const username = match[2];
    if (username) {
      usernames.add(username.toLowerCase());
    }
  }

  return { usernames, userIds };
}

function containsMention(body: string, mention: string): boolean {
  const target = parseMentionTarget(mention);
  if (!target) {
    return false;
  }

  const candidates = extractMentionCandidates(body);
  if (target.kind === "user_id") {
    return candidates.userIds.has(target.value);
  }

  return candidates.usernames.has(target.value);
}

function isDeniAiSystemComment(body: string): boolean {
  return body.includes("<!-- deniai:reviewing:start -->") || body.includes("<!-- deniai:reviewing:end -->");
}
async function findLatestReviewingCommentId(params: {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
}): Promise<number | undefined> {
async function findLatestReviewingCommentId(params: {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
  const comments = await listIssueComments({
    token: params.token,
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.pullNumber,
  });

  const comments = await listIssueComments({
    token: params.token,
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.pullNumber,
  });

  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    if (comment && isDeniAiSystemComment(comment.body)) {
      return comment.id;
    }
  }

  return undefined;
}

async function upsertReviewingComment(params: {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
  reviewingBody: string;
  context: "pull_request" | "mention-trigger";
}): Promise<number | undefined> {
  let existingCommentId: number | undefined;
  try {
    existingCommentId = await findLatestReviewingCommentId({
      token: params.token,
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
    });
  } catch (error) {
    console.warn(`[${params.context}] Failed to find existing reviewing comment`, error);
  }

  if (existingCommentId) {
    try {
      await updateIssueComment({
        token: params.token,
        owner: params.owner,
        repo: params.repo,
        commentId: existingCommentId,
        body: params.reviewingBody,
      });
      console.info(
        `[${params.context}] Updated reviewing comment ${existingCommentId} on ${params.owner}/${params.repo}#${params.pullNumber}`,
      );
      return existingCommentId;
    } catch (error) {
      console.warn(`[${params.context}] Failed to update reviewing comment ${existingCommentId}`, error);
    }
  }

  try {
    const progressCommentId = await createIssueComment({
      token: params.token,
      owner: params.owner,
      repo: params.repo,
      issueNumber: params.pullNumber,
      body: params.reviewingBody,
    });
    console.info(
      `[${params.context}] Posted reviewing comment ${progressCommentId} on ${params.owner}/${params.repo}#${params.pullNumber}`,
    );
    return progressCommentId;
  } catch (error) {
    console.warn(`[${params.context}] Failed to post reviewing comment`, error);
    return undefined;
  }
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

  return upsertReviewingComment({
    token: params.token,
    owner: params.owner,
    repo: params.repo,
    pullNumber: params.pullNumber,
    reviewingBody,
    context: "mention-trigger",
  });
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
    "## Harbor is at work...",
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
    `Target: ${params.owner}/${params.repo}#${params.pullNumber}`,
    "",
    "<details>",
    "<summary>Progress Overview (in progress)</summary>",
    "",
    "### Current Progress",
    "- Collecting changed files and diffs",
    "- Analyzing risks and boundary conditions",
    "- Preparing candidate inline comments",
    "",
    "### Output After Completion",
    "- Post suggestion comments on applicable diff lines",
    "- Post an overall summary comment in the final review",
    "",
    "</details>",
    "",
    "_Review is running. Final results will be posted shortly._",
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
  const statusLine = params.error ? "## Harbor threw error" : "## Harbor finished work";

  let resultSummary = "- Result: Review processing completed.";
  if (params.error) {
    resultSummary = `- Result: Failed (${String((params.error as Error)?.message ?? params.error)})`;
  } else if (params.outcome?.status === "posted") {
    resultSummary = `- Result: Review submitted (${params.outcome.inlineCommentCount} inline comments).`;
  } else if (params.outcome?.status === "no_suggestions") {
    resultSummary = "- Result: No safely postable suggestions were found.";
  } else if (params.outcome?.status === "approved") {
    resultSummary = "- Result: Approved (no actionable issues).";
  } else if (params.outcome?.status === "skipped_no_llm") {
    resultSummary = "- Result: Skipped because no LLM provider is configured.";
  }

  const bodySummary = params.outcome?.hasSummaryBody
    ? "- Overall summary comment: posted."
    : "- Overall summary comment: none.";

  return [
    "<!-- deniai:reviewing:start -->",
    "<!-- auto-generated by deni-ai-harbor -->",
    "",
    statusLine,
    "",
    `Target: ${params.owner}/${params.repo}#${params.pullNumber}`,
    "",
    "<details>",
    "<summary>Review Run Result</summary>",
    "",
    "### Run Result",
    resultSummary,
    bodySummary,
    `- Processing time: ~${elapsedSeconds}s`,
    "",
    "</details>",
    "",
    "<!-- deniai:reviewing:end -->",
  ].join("\n");
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replaceAll("\\", "/");
}

interface FallbackSuggestion {
  path: string;
  line: number;
  reason: string;
}

function buildFallbackSection(items: FallbackSuggestion[]): string {
  const lines = [`${items.length} suggestion(s) could not be attached inline:`];

  for (const item of items) {
    lines.push(`- ${item.path}:${item.line} (${item.reason})`);
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
  const fallbackItems: FallbackSuggestion[] = [];
  const seen = new Set<string>();

  for (const suggestion of params.suggestions) {
    const path = normalizePath(suggestion.path);
    const file = fileMap.get(path);

    if (!file || !file.patch) {
      fallbackItems.push({
        path,
        line: suggestion.line,
        reason: "patch is unavailable",
      });
      continue;
    }

    const positionMap = buildAddedLineToPositionMap(file.patch);
    const position = positionMap.get(suggestion.line);

    if (!position) {
      fallbackItems.push({
        path,
        line: suggestion.line,
        reason: "line is not an added diff line",
      });
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
  if (!headSha) {
    const head = await getPullRequestHead({
      token,
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
    });
    headSha = head.headSha;
  }

  if (!headSha) {
    throw new Error(`[review] Missing head SHA for ${params.owner}/${params.repo}#${params.pullNumber}`);
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

  let workdirSession: Awaited<ReturnType<typeof createWorkdirSession>>;
  try {
    workdirSession = await createWorkdirSession({
      token,
      repoOwner: params.owner,
      repoName: params.repo,
      pullNumber: params.pullNumber,
      headSha,
      cloneUrl: params.cloneUrl,
    });
  } catch (error) {
    console.error(
      `[review] Failed to prepare workdir for ${params.owner}/${params.repo}#${params.pullNumber}. clone_url=${params.cloneUrl ?? "(none)"}`,
      error,
    );
    throw error;
  }

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

    const explicitReviewOk = llmResult.overallComment?.trim() === REVIEW_OK_COMMENT;
    const explicitApprovalKey = llmResult.allowAutoApprove === true;
    const canApprove =
      llmResult.overallStatus === "ok" &&
      llmResult.suggestions.length === 0 &&
      (explicitReviewOk || explicitApprovalKey);

    if (canApprove) {
      await createPullRequestReview({
        token,
        owner: params.owner,
        repo: params.repo,
        pullNumber: params.pullNumber,
        event: "APPROVE",
        body: REVIEW_OK_COMMENT,
      });
      console.info(`[review] Approved ${params.owner}/${params.repo}#${params.pullNumber} (no actionable issues).`);
      return {
        status: "approved",
        inlineCommentCount: 0,
        hasSummaryBody: true,
      };
    }

    const safeOverallComment =
      llmResult.overallComment?.trim() ||
      (llmResult.suggestions.length === 0
        ? "Review completed without auto-approval because confidence was insufficient."
        : undefined);

    const reviewPayload = buildReviewPayload({
      suggestions: llmResult.suggestions,
      overallComment: safeOverallComment,
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
    progressCommentId = await upsertReviewingComment({
      token,
      owner,
      repo,
      pullNumber,
      reviewingBody,
      context: "pull_request",
    });
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
        cloneUrl: payload.repository.clone_url,
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

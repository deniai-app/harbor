import type { GitHubPullRequestFile, SuggestionCandidate } from "@workspace/shared";
import { buildAddedLineToPositionMap, extractPatchByFile } from "../diff/patch";
import { createWorkdirSession } from "../git/workdir";
import {
  createCommitStatus,
  createIssueComment,
  createIssueCommentReaction,
  createPullRequestReview,
  createPullRequestReviewCommentReaction,
  createCheckRun,
  dismissPullRequestReview,
  getAuthenticatedLogin,
  updateCheckRun,
  getPullRequestDiff,
  getPullRequestFiles,
  getPullRequestHead,
  listPullRequestReviews,
  listIssueComments,
  mapCommitStatusState,
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
    clone_url?: string;
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
    clone_url?: string;
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
    clone_url?: string;
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

async function dismissExistingBotApprovals(params: {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
}): Promise<void> {
  try {
    const login = await getAuthenticatedLogin({
      token: params.token,
    });
    const normalizedLogin = login.trim().toLowerCase();
    console.info(
      `[review] Checking existing approvals by ${login} for ${params.owner}/${params.repo}#${params.pullNumber}`,
    );

    const reviews = await listPullRequestReviews({
      token: params.token,
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
    });

    const approvals = reviews.filter(
      (review) =>
        review.state === "APPROVED" && review.user?.login?.toLowerCase() === normalizedLogin,
    );

    if (approvals.length === 0) {
      console.info(
        `[review] No prior approvals to dismiss for ${params.owner}/${params.repo}#${params.pullNumber}`,
      );
      return;
    }

    console.info(
      `[review] Dismissing ${approvals.length} prior approval(s) for ${params.owner}/${params.repo}#${params.pullNumber}`,
    );

    for (const approval of approvals) {
      try {
        await dismissPullRequestReview({
          token: params.token,
          owner: params.owner,
          repo: params.repo,
          pullNumber: params.pullNumber,
          reviewId: approval.id,
          message: "Superseded by a new Harbor rerun.",
        });
        console.info(
          `[review] Dismissed prior approval review_id=${approval.id} for ${params.owner}/${params.repo}#${params.pullNumber}`,
        );
      } catch (error) {
        console.warn(
          `[review] Failed to dismiss prior approval review_id=${approval.id} for ${params.owner}/${params.repo}#${params.pullNumber}`,
          error,
        );
      }
    }
  } catch (error) {
    console.warn(
      `[review] Failed while checking existing approvals for ${params.owner}/${params.repo}#${params.pullNumber}`,
      error,
    );
  }
}

function isTargetAction(
  action: string,
): action is "opened" | "ready_for_review" | "reopened" | "synchronize" {
  return (
    action === "opened" ||
    action === "ready_for_review" ||
    action === "reopened" ||
    action === "synchronize"
  );
}

function isCommentCreatedAction(action: string): action is "created" {
  return action === "created";
}

function isPullRequestReviewAction(action: string): action is "submitted" | "edited" {
  return action === "submitted" || action === "edited";
}

const GITHUB_USER_ID_MENTION_PATTERN = /<@([a-z0-9_-]+)>/gi;
const GITHUB_USERNAME_MENTION_PATTERN =
  /(^|[^a-z0-9-])@([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)(?=[^a-z0-9-]|$)/gi;
const MAX_FALLBACK_SUGGESTIONS = 12;

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

function stripCodeLikeSections(body: string): string {
  return body.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
}

function extractMentionCandidates(body: string): { usernames: Set<string>; userIds: Set<string> } {
  const normalizedBody = stripCodeLikeSections(body);
  const usernames = new Set<string>();
  const userIds = new Set<string>();

  for (const match of normalizedBody.matchAll(GITHUB_USER_ID_MENTION_PATTERN)) {
    const id = match[1];
    if (id) {
      userIds.add(id.toLowerCase());
    }
  }

  for (const match of normalizedBody.matchAll(GITHUB_USERNAME_MENTION_PATTERN)) {
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
  return (
    body.includes("<!-- deniai:reviewing:start -->") ||
    body.includes("<!-- deniai:reviewing:end -->")
  );
}

async function findLatestReviewingCommentId(params: {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
}): Promise<number | undefined> {
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
      console.warn(
        `[${params.context}] Failed to update reviewing comment ${existingCommentId}`,
        error,
      );
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
}): Promise<void> {
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
}

const REVIEWING_COMMENT_SOURCE = "pull_request" as const;

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
      console.warn(
        "[review] Failed to generate AI reviewing comment. Falling back to template.",
        error,
      );
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

const REVIEWING_CHECK_NAME = "Deni AI Harbor";

function buildShortCommitStatusDescription(summary: string): string {
  const trimmedSummary = summary.trim();
  if (trimmedSummary.length <= 140) {
    return trimmedSummary;
  }

  return `${trimmedSummary.slice(0, 137)}...`;
}

function buildInProgressReviewingCheckOutput(params: {
  owner: string;
  repo: string;
  pullNumber: number;
}): { title: string; summary: string; text: string } {
  return {
    title: "Harbor Review Running",
    summary: `${params.owner}/${params.repo}#${params.pullNumber} is being reviewed by Deni AI Harbor.`,
    text: "Inline review and summary will be posted when complete.",
  };
}

function buildCompletedReviewingCheckOutput(params: {
  owner: string;
  repo: string;
  pullNumber: number;
  outcome?: ReviewRunOutcome;
  error?: unknown;
  elapsedSeconds: number;
}): { title: string; summary: string; text: string } {
  let resultSummary = "Harbor review completed.";
  let title = "Harbor review completed";

  if (params.error) {
    title = "Harbor review failed";
    resultSummary = `Harbor review failed: ${String((params.error as Error)?.message ?? params.error)}`;
  } else if (params.outcome?.status === "posted") {
    title = "Harbor review posted";
    resultSummary = `Harbor review posted (${params.outcome.inlineCommentCount} inline comments).`;
  } else if (params.outcome?.status === "approved") {
    title = "Harbor approved PR";
    resultSummary = "Harbor approved PR (no actionable issues).";
  } else if (params.outcome?.status === "no_suggestions") {
    title = "Harbor review completed";
    resultSummary = "Harbor review completed with no safely postable suggestions.";
  } else if (params.outcome?.status === "skipped_no_llm") {
    title = "Harbor review skipped";
    resultSummary = "Harbor review skipped because no LLM provider is configured.";
  }

  const summaryBody = params.outcome?.hasSummaryBody
    ? "Overall summary comment posted."
    : "Overall summary comment was not posted.";

  return {
    title,
    summary: `${params.owner}/${params.repo}#${params.pullNumber}: ${resultSummary}`,
    text: [
      `Status: ${resultSummary}`,
      summaryBody,
      `Estimated processing time: ~${params.elapsedSeconds}s`,
    ].join("\n\n"),
  };
}

function mapReviewOutcomeToConclusion(params: {
  outcome?: ReviewRunOutcome;
  error?: unknown;
}): "success" | "failure" | "neutral" {
  if (params.error) {
    return "failure";
  }

  if (
    params.outcome?.status === "approved" ||
    params.outcome?.status === "no_suggestions" ||
    params.outcome?.status === "skipped_no_llm"
  ) {
    return "success";
  }

  return "neutral";
}

async function startReviewProgressComment(params: {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
  llmProvider: ReviewLlmProvider | null;
  context: "pull_request" | "mention-trigger";
}): Promise<number | undefined> {
  try {
    const reviewingBody = await buildReviewingComment({
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
      source: REVIEWING_COMMENT_SOURCE,
      llmProvider: params.llmProvider,
    });

    return await upsertReviewingComment({
      token: params.token,
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
      reviewingBody,
      context: params.context,
    });
  } catch (error) {
    console.warn(`[${params.context}] Failed to post reviewing comment`, error);
    return undefined;
  }
}

async function runReviewWithProgressTracking(
  params: ReviewRequestInput & {
    token: string;
    context: "pull_request" | "mention-trigger";
  },
  deps: ProcessPullRequestEventDeps,
): Promise<void> {
  const startedAt = Date.now();
  const progressCommentId = await startReviewProgressComment({
    token: params.token,
    owner: params.owner,
    repo: params.repo,
    pullNumber: params.pullNumber,
    llmProvider: deps.llmProvider,
    context: params.context,
  });

  let outcome: ReviewRunOutcome | undefined;
  let reviewError: unknown;
  try {
    outcome = await runReviewForPullRequest(params, deps);
  } catch (error) {
    reviewError = error;
  }

  if (progressCommentId) {
    try {
      await updateIssueComment({
        token: params.token,
        owner: params.owner,
        repo: params.repo,
        commentId: progressCommentId,
        body: buildCompletedReviewingComment({
          owner: params.owner,
          repo: params.repo,
          pullNumber: params.pullNumber,
          startedAt,
          finishedAt: Date.now(),
          outcome,
          error: reviewError,
        }),
      });
      console.info(
        `[${params.context}] Finalized reviewing comment ${progressCommentId} on ${params.owner}/${params.repo}#${params.pullNumber}`,
      );
    } catch (error) {
      console.warn(`[${params.context}] Failed to finalize reviewing comment`, error);
    }
  }

  if (reviewError) {
    throw reviewError;
  }
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
  const normalized = items.map((item) => `${item.path}:${item.line} (${item.reason})`);
  const lines = [
    `${items.length} suggestion(s) could not be attached inline:`,
    ...normalized.slice(0, MAX_FALLBACK_SUGGESTIONS).map((line) => `- ${line}`),
  ];

  if (normalized.length > MAX_FALLBACK_SUGGESTIONS) {
    lines.push(`- ... and ${normalized.length - MAX_FALLBACK_SUGGESTIONS} more`);
  }

  return lines.join("\n").trim();
}

function buildReviewPayload(params: {
  suggestions: SuggestionCandidate[];
  overallComment?: string;
  files: GitHubPullRequestFile[];
}): { comments: ReviewCommentInput[]; body?: string } | null {
  const fileMap = new Map<string, GitHubPullRequestFile>();
  for (const file of params.files) {
    fileMap.set(file.filename, file);
    fileMap.set(normalizePath(file.filename), file);
  }

  const comments: ReviewCommentInput[] = [];
  const fallbackItems: FallbackSuggestion[] = [];
  const seen = new Set<string>();
  const fallbackSeen = new Set<string>();

  for (const suggestion of params.suggestions) {
    const path = normalizePath(suggestion.path);
    const file = fileMap.get(path) ?? fileMap.get(`./${path}`);

    if (!file || !file.patch) {
      const key = `${path}:${suggestion.line}:missing-patch`;
      if (!fallbackSeen.has(key)) {
        fallbackSeen.add(key);
        fallbackItems.push({
          path,
          line: suggestion.line,
          reason: "patch is unavailable",
        });
      }
      continue;
    }

    const positionMap = buildAddedLineToPositionMap(file.patch);
    const position = positionMap.get(suggestion.line);

    if (!position) {
      const key = `${path}:${suggestion.line}:not-added`;
      if (!fallbackSeen.has(key)) {
        fallbackSeen.add(key);
        fallbackItems.push({
          path,
          line: suggestion.line,
          reason: "line is not an added diff line",
        });
      }
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
  const token = params.token ?? (await deps.auth.getInstallationToken(params.installationId));
  console.info(`[review] Start review for ${params.owner}/${params.repo}#${params.pullNumber}`);

  const reviewStartedAt = Date.now();

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
    throw new Error(
      `[review] Missing head SHA for ${params.owner}/${params.repo}#${params.pullNumber}`,
    );
  }

  let checkRunId: number | undefined;
  try {
    checkRunId = await createCheckRun({
      token,
      owner: params.owner,
      repo: params.repo,
      name: REVIEWING_CHECK_NAME,
      headSha,
      output: buildInProgressReviewingCheckOutput({
        owner: params.owner,
        repo: params.repo,
        pullNumber: params.pullNumber,
      }),
    });
    console.info(
      `[review] Using check run ${checkRunId} for ${params.owner}/${params.repo}#${params.pullNumber}`,
    );
  } catch (error) {
    console.warn(
      `[review] Failed to create check run for ${params.owner}/${params.repo}#${params.pullNumber}`,
      error,
    );

    try {
      const pendingStatusSummary = buildInProgressReviewingCheckOutput({
        owner: params.owner,
        repo: params.repo,
        pullNumber: params.pullNumber,
      }).summary;

      await createCommitStatus({
        token,
        owner: params.owner,
        repo: params.repo,
        sha: headSha,
        context: REVIEWING_CHECK_NAME,
        state: mapCommitStatusState("pending"),
        description: buildShortCommitStatusDescription(pendingStatusSummary),
      });
      console.info(
        `[review] Check run unavailable, fallback commit status set to pending for ${params.owner}/${params.repo}#${params.pullNumber}`,
      );
    } catch (statusError) {
      console.warn(
        `[review] Failed to create pending fallback commit status for ${params.owner}/${params.repo}#${params.pullNumber}`,
        statusError,
      );
    }
  }

  let outcome: ReviewRunOutcome | undefined;
  let reviewError: unknown;
  let workdirSession: Awaited<ReturnType<typeof createWorkdirSession>> | undefined;

  try {
    if (!deps.llmProvider) {
      console.warn("LLM provider is unavailable. Skipping automated suggestions.");
      outcome = {
        status: "skipped_no_llm",
        inlineCommentCount: 0,
        hasSummaryBody: false,
      };
      return outcome;
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
    console.info(
      `[review] LLM produced ${llmResult.suggestions.length} suggestion candidates for ${params.owner}/${params.repo}#${params.pullNumber}`,
    );

    const explicitReviewOk = llmResult.overallComment?.trim() === REVIEW_OK_COMMENT;
    const explicitApprovalKey = llmResult.allowAutoApprove === true;
    const canApprove =
      llmResult.overallStatus === "ok" &&
      llmResult.suggestions.length === 0 &&
      (explicitReviewOk || explicitApprovalKey);

    if (canApprove) {
      await dismissExistingBotApprovals({
        token,
        owner: params.owner,
        repo: params.repo,
        pullNumber: params.pullNumber,
      });

      await createPullRequestReview({
        token,
        owner: params.owner,
        repo: params.repo,
        pullNumber: params.pullNumber,
        event: "APPROVE",
        body: REVIEW_OK_COMMENT,
      });
      console.info(
        `[review] Approved ${params.owner}/${params.repo}#${params.pullNumber} (no actionable issues).`,
      );
      outcome = {
        status: "approved",
        inlineCommentCount: 0,
        hasSummaryBody: true,
      };
      return outcome;
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
      console.info(
        `[review] No safe suggestions for ${params.owner}/${params.repo}#${params.pullNumber}`,
      );
      outcome = {
        status: "no_suggestions",
        inlineCommentCount: 0,
        hasSummaryBody: false,
      };
      return outcome;
    }

    await dismissExistingBotApprovals({
      token,
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
    });

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
    outcome = {
      status: "posted",
      inlineCommentCount: reviewPayload.comments.length,
      hasSummaryBody: Boolean(reviewPayload.body),
    };
    return outcome;
  } catch (error) {
    reviewError = error;
    throw error;
  } finally {
    if (workdirSession) {
      try {
        await workdirSession.cleanup();
      } finally {
        console.info(
          `[review] Finished review for ${params.owner}/${params.repo}#${params.pullNumber}`,
        );
      }
    }

    const finishedAt = Date.now();
    const elapsedSeconds = Math.max(1, Math.round((finishedAt - reviewStartedAt) / 1000));
    const completedOutput = buildCompletedReviewingCheckOutput({
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
      outcome,
      error: reviewError,
      elapsedSeconds,
    });

    if (checkRunId) {
      try {
        await updateCheckRun({
          token,
          owner: params.owner,
          repo: params.repo,
          checkRunId,
          status: "completed",
          conclusion: mapReviewOutcomeToConclusion({
            outcome,
            error: reviewError,
          }),
          output: completedOutput,
          completedAt: new Date(finishedAt).toISOString(),
        });
        console.info(
          `[review] Updated check run ${checkRunId} for ${params.owner}/${params.repo}#${params.pullNumber}`,
        );
      } catch (error) {
        console.warn(
          `[review] Failed to update check run ${checkRunId} for ${params.owner}/${params.repo}#${params.pullNumber}`,
          error,
        );
      }
    } else {
      const finalStatusState = mapCommitStatusState("completed", reviewError);
      const finalDescription = buildShortCommitStatusDescription(completedOutput.summary);
      try {
        await createCommitStatus({
          token,
          owner: params.owner,
          repo: params.repo,
          sha: headSha,
          context: REVIEWING_CHECK_NAME,
          state: finalStatusState,
          description: finalDescription,
        });
        console.info(
          `[review] Check run unavailable, fallback commit status finalized state=${finalStatusState} for ${params.owner}/${params.repo}#${params.pullNumber}`,
        );
      } catch (statusError) {
        console.warn(
          `[review] Failed to finalize fallback commit status for ${params.owner}/${params.repo}#${params.pullNumber}`,
          statusError,
        );
      }
    }

    if (reviewError) {
      console.info(
        `[review] Checked failure for ${params.owner}/${params.repo}#${params.pullNumber}: ${String((reviewError as Error)?.message ?? reviewError)}`,
      );
    }
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

  console.info(
    `[pull_request] Trigger review for ${owner}/${repo}#${pullNumber} action=${payload.action}`,
  );

  const token = await deps.auth.getInstallationToken(installationId);
  await runReviewWithProgressTracking(
    {
      installationId,
      owner,
      repo,
      pullNumber,
      headSha: payload.pull_request.head.sha,
      cloneUrl: payload.repository.clone_url,
      token,
      context: "pull_request",
    },
    deps,
  );
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

  console.info(
    `[issue_comment] Mention detected. Trigger review for ${owner}/${repo}#${pullNumber}`,
  );
  const token = await deps.auth.getInstallationToken(installationId);

  await notifyMentionTriggered({
    token,
    owner,
    repo,
    pullNumber,
    source: "issue_comment",
    commentId: payload.comment.id,
  });

  await runReviewWithProgressTracking(
    {
      installationId,
      owner,
      repo,
      pullNumber,
      cloneUrl: payload.repository.clone_url,
      token,
      context: "mention-trigger",
    },
    deps,
  );
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

  console.info(
    `[pull_request_review] Mention detected. Trigger review for ${owner}/${repo}#${pullNumber}`,
  );
  const token = await deps.auth.getInstallationToken(installationId);

  await notifyMentionTriggered({
    token,
    owner,
    repo,
    pullNumber,
    source: "pull_request_review",
    commentId: payload.review.id,
  });

  await runReviewWithProgressTracking(
    {
      installationId,
      owner,
      repo,
      pullNumber,
      cloneUrl: payload.repository.clone_url,
      token,
      context: "mention-trigger",
    },
    deps,
  );
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

  console.info(
    `[pull_request_review_comment] Mention detected. Trigger review for ${owner}/${repo}#${pullNumber}`,
  );
  const token = await deps.auth.getInstallationToken(installationId);

  await notifyMentionTriggered({
    token,
    owner,
    repo,
    pullNumber,
    source: "pull_request_review_comment",
    commentId: payload.comment.id,
  });

  await runReviewWithProgressTracking(
    {
      installationId,
      owner,
      repo,
      pullNumber,
      cloneUrl: payload.repository.clone_url,
      token,
      context: "mention-trigger",
    },
    deps,
  );
}

import { Octokit } from "@octokit/rest";
import type { GitHubPullRequestFile } from "@workspace/shared";

function buildClient(token: string): Octokit {
  return new Octokit({
    auth: token,
  });
}

async function handleApiResponse<T>(operation: () => Promise<{ data: T }>): Promise<T> {
  try {
    const response = await operation();
    return response.data;
  } catch (error) {
    const anyError = error as {
      status?: number;
      message?: string;
      response?: { data?: unknown };
    };

    const status = anyError.status;
    const details = (() => {
      const body = anyError.response?.data;
      if (typeof body === "string") {
        return body;
      }

      if (body && typeof body === "object") {
        return JSON.stringify(body);
      }

      return undefined;
    })();

    const suffix = details ? `: ${details}` : anyError.message ? `: ${anyError.message}` : "";
    throw new Error(`GitHub API error ${status ?? "unknown"}${suffix}`);
  }
}

export async function getPullRequestFiles(params: {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
}): Promise<GitHubPullRequestFile[]> {
  const octokit = buildClient(params.token);

  const allFiles = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber,
    per_page: 100,
  });

  return allFiles as GitHubPullRequestFile[];
}

export async function getPullRequestDiff(params: {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
}): Promise<string> {
  const octokit = buildClient(params.token);

  return handleApiResponse(async () => {
    const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
      mediaType: {
        previews: [],
      },
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
    });

    return { data: response.data as unknown as string };
  });
}

interface PullRequestHeadResponse {
  head: {
    sha: string;
    repo: {
      clone_url?: string | null;
    } | null;
  };
}

export async function getPullRequestHead(params: {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
}): Promise<{ headSha: string; cloneUrl?: string }> {
  const octokit = buildClient(params.token);

  const data = await handleApiResponse(async () => {
    return octokit.rest.pulls.get({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
    });
  });

  const typed = data as unknown as PullRequestHeadResponse;
  return {
    headSha: typed.head.sha,
    cloneUrl: typed.head.repo?.clone_url ?? undefined,
  };
}

export async function createIssueComment(params: {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}): Promise<number> {
  const octokit = buildClient(params.token);

  const data = await handleApiResponse(async () =>
    octokit.rest.issues.createComment({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.issueNumber,
      body: params.body,
    }),
  );

  const commentId = (data as { id?: number }).id;
  if (typeof commentId !== "number" || !Number.isInteger(commentId)) {
    throw new Error("Failed to parse created issue comment id.");
  }
  return commentId;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface AuthenticatedUser {
  login: string;
}

export interface PullRequestReview {
  id: number;
  state: string;
  user: {
    login?: string;
  } | null;
}

export async function listIssueComments(params: {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
}): Promise<IssueComment[]> {
  const octokit = buildClient(params.token);

  const allComments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: params.owner,
    repo: params.repo,
    issue_number: params.issueNumber,
    per_page: 100,
    sort: "created",
    direction: "asc",
  });

  return allComments
    .map((comment) => ({
      id: comment.id,
      body: comment.body ?? "",
    }))
    .filter((comment) => Number.isInteger(comment.id) && comment.id > 0);
}

export async function getAuthenticatedLogin(params: { token: string }): Promise<string> {
  const octokit = buildClient(params.token);

  const data = await handleApiResponse(async () => octokit.rest.users.getAuthenticated());
  const login = (data as AuthenticatedUser).login;

  if (typeof login !== "string" || login.trim().length === 0) {
    throw new Error("Failed to get authenticated GitHub login.");
  }

  return login;
}

export async function listPullRequestReviews(params: {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
}): Promise<PullRequestReview[]> {
  const octokit = buildClient(params.token);

  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber,
    per_page: 100,
  });

  return reviews.map((review) => ({
    id: review.id,
    state: review.state,
    user: review.user ? { login: review.user.login } : null,
  }));
}

export async function dismissPullRequestReview(params: {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
  reviewId: number;
  message: string;
}): Promise<void> {
  const octokit = buildClient(params.token);

  await handleApiResponse(async () =>
    octokit.rest.pulls.dismissReview({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
      review_id: params.reviewId,
      message: params.message,
    }),
  );
}

export async function updateIssueComment(params: {
  token: string;
  owner: string;
  repo: string;
  commentId: number;
  body: string;
}): Promise<void> {
  const octokit = buildClient(params.token);

  await handleApiResponse(async () =>
    octokit.rest.issues.updateComment({
      owner: params.owner,
      repo: params.repo,
      comment_id: params.commentId,
      body: params.body,
    }),
  );
}

export async function createIssueCommentReaction(params: {
  token: string;
  owner: string;
  repo: string;
  commentId: number;
}): Promise<void> {
  const octokit = buildClient(params.token);

  await handleApiResponse(async () =>
    octokit.rest.reactions.createForIssueComment({
      owner: params.owner,
      repo: params.repo,
      comment_id: params.commentId,
      content: "eyes",
    }),
  );
}

export async function createPullRequestReviewCommentReaction(params: {
  token: string;
  owner: string;
  repo: string;
  commentId: number;
}): Promise<void> {
  const octokit = buildClient(params.token);

  await handleApiResponse(async () =>
    octokit.rest.reactions.createForPullRequestReviewComment({
      owner: params.owner,
      repo: params.repo,
      comment_id: params.commentId,
      content: "eyes",
    }),
  );
}

export interface ReviewCommentInput {
  path: string;
  position: number;
  body: string;
}

export type PullRequestReviewEvent = "COMMENT" | "APPROVE";

export interface CheckOutput {
  title: string;
  summary: string;
  text?: string;
}

export type CheckRunStatus = "queued" | "in_progress" | "completed";
export type CheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "stale"
  | "skipped";
export type CommitStatusState = "error" | "failure" | "pending" | "success";

export interface CheckRun {
  id: number;
  name: string;
}

export function mapCommitStatusState(
  mode: "pending" | "completed",
  reviewError?: unknown,
): CommitStatusState {
  if (mode === "pending") {
    return "pending";
  }

  return reviewError ? "failure" : "success";
}

export async function createCheckRun(params: {
  token: string;
  owner: string;
  repo: string;
  name: string;
  headSha: string;
  detailsUrl?: string;
  output: CheckOutput;
}): Promise<number> {
  const octokit = buildClient(params.token);

  const data = await handleApiResponse(async () =>
    octokit.rest.checks.create({
      owner: params.owner,
      repo: params.repo,
      name: params.name,
      head_sha: params.headSha,
      status: "in_progress",
      started_at: new Date().toISOString(),
      details_url: params.detailsUrl,
      output: params.output,
    }),
  );

  const checkRunId = (data as { id?: number }).id;
  if (typeof checkRunId !== "number" || !Number.isInteger(checkRunId)) {
    throw new Error("Failed to parse created check run id.");
  }
  return checkRunId;
}

export async function updateCheckRun(params: {
  token: string;
  owner: string;
  repo: string;
  checkRunId: number;
  status: CheckRunStatus;
  conclusion?: CheckRunConclusion;
  output?: CheckOutput;
  completedAt?: string;
}): Promise<void> {
  const octokit = buildClient(params.token);

  await handleApiResponse(async () =>
    octokit.rest.checks.update({
      owner: params.owner,
      repo: params.repo,
      check_run_id: params.checkRunId,
      status: params.status,
      conclusion: params.conclusion,
      output: params.output,
      completed_at: params.completedAt,
    }),
  );
}

export async function createCommitStatus(params: {
  token: string;
  owner: string;
  repo: string;
  sha: string;
  context: string;
  state: CommitStatusState;
  description: string;
  targetUrl?: string;
}): Promise<void> {
  const octokit = buildClient(params.token);

  const normalizedDescription =
    params.description.length > 140 ? `${params.description.slice(0, 137)}...` : params.description;

  await handleApiResponse(async () =>
    octokit.rest.repos.createCommitStatus({
      owner: params.owner,
      repo: params.repo,
      sha: params.sha,
      context: params.context,
      state: params.state,
      description: normalizedDescription,
      target_url: params.targetUrl,
    }),
  );
}

export async function createPullRequestReview(params: {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
  event?: PullRequestReviewEvent;
  body?: string;
  comments?: ReviewCommentInput[];
}): Promise<void> {
  const octokit = buildClient(params.token);

  const payload: {
    event: PullRequestReviewEvent;
    body?: string;
    comments?: ReviewCommentInput[];
  } = {
    event: params.event ?? "COMMENT",
  };

  if (params.body) {
    payload.body = params.body;
  }

  if (params.comments && params.comments.length > 0) {
    payload.comments = params.comments;
  }

  await handleApiResponse(async () =>
    octokit.rest.pulls.createReview({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
      event: params.event ?? "COMMENT",
      body: payload.body,
      comments: payload.comments,
    }),
  );
}

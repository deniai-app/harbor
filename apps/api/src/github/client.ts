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

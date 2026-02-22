import type { GitHubPullRequestFile } from "@workspace/shared";

const GITHUB_API_BASE = "https://api.github.com";

interface GitHubRequestInput {
  token: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

async function githubRequest({ token, method = "GET", path, headers, body }: GitHubRequestInput): Promise<Response> {
  return fetch(`${GITHUB_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${raw}`);
  }
  return (await response.json()) as T;
}

export async function getPullRequestFiles(params: {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
}): Promise<GitHubPullRequestFile[]> {
  const files: GitHubPullRequestFile[] = [];
  let page = 1;

  while (true) {
    const response = await githubRequest({
      token: params.token,
      path: `/repos/${params.owner}/${params.repo}/pulls/${params.pullNumber}/files?per_page=100&page=${page}`,
    });
    const data = await parseResponse<GitHubPullRequestFile[]>(response);
    files.push(...data);

    if (data.length < 100) {
      break;
    }
    page += 1;
  }

  return files;
}

export async function getPullRequestDiff(params: {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
}): Promise<string> {
  const response = await githubRequest({
    token: params.token,
    path: `/repos/${params.owner}/${params.repo}/pulls/${params.pullNumber}`,
    headers: {
      Accept: "application/vnd.github.v3.diff",
    },
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`GitHub diff error ${response.status}: ${raw}`);
  }

  return await response.text();
}

interface PullRequestHeadResponse {
  head: {
    sha: string;
    repo: {
      clone_url: string;
    };
  };
}

export async function getPullRequestHead(params: {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
}): Promise<{ headSha: string; cloneUrl: string }> {
  const response = await githubRequest({
    token: params.token,
    path: `/repos/${params.owner}/${params.repo}/pulls/${params.pullNumber}`,
  });
  const data = await parseResponse<PullRequestHeadResponse>(response);
  return {
    headSha: data.head.sha,
    cloneUrl: data.head.repo.clone_url,
  };
}

export async function createIssueComment(params: {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}): Promise<number> {
  const response = await githubRequest({
    token: params.token,
    method: "POST",
    path: `/repos/${params.owner}/${params.repo}/issues/${params.issueNumber}/comments`,
    body: {
      body: params.body,
    },
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`Failed to create issue comment ${response.status}: ${raw}`);
  }

  const data = (await response.json()) as { id?: number };
  const commentId = data.id;
  if (typeof commentId !== "number" || !Number.isInteger(commentId)) {
    throw new Error("Failed to parse created issue comment id.");
  }
  return commentId;
}

export async function updateIssueComment(params: {
  token: string;
  owner: string;
  repo: string;
  commentId: number;
  body: string;
}): Promise<void> {
  const response = await githubRequest({
    token: params.token,
    method: "PATCH",
    path: `/repos/${params.owner}/${params.repo}/issues/comments/${params.commentId}`,
    body: {
      body: params.body,
    },
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`Failed to update issue comment ${response.status}: ${raw}`);
  }
}

export async function createIssueCommentReaction(params: {
  token: string;
  owner: string;
  repo: string;
  commentId: number;
}): Promise<void> {
  const response = await githubRequest({
    token: params.token,
    method: "POST",
    path: `/repos/${params.owner}/${params.repo}/issues/comments/${params.commentId}/reactions`,
    body: {
      content: "eyes",
    },
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`Failed to create issue comment reaction ${response.status}: ${raw}`);
  }
}

export async function createPullRequestReviewCommentReaction(params: {
  token: string;
  owner: string;
  repo: string;
  commentId: number;
}): Promise<void> {
  const response = await githubRequest({
    token: params.token,
    method: "POST",
    path: `/repos/${params.owner}/${params.repo}/pulls/comments/${params.commentId}/reactions`,
    body: {
      content: "eyes",
    },
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`Failed to create PR review comment reaction ${response.status}: ${raw}`);
  }
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

  const response = await githubRequest({
    token: params.token,
    method: "POST",
    path: `/repos/${params.owner}/${params.repo}/pulls/${params.pullNumber}/reviews`,
    body: payload,
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`Failed to create review ${response.status}: ${raw}`);
  }
}

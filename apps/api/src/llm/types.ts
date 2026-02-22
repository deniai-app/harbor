import type { GitHubPullRequestFile, SuggestionResult } from "@workspace/shared";
import type { VirtualIdeTools } from "../virtual-ide/context";

export interface GenerateSuggestionInput {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  changedFiles: GitHubPullRequestFile[];
  virtualIdeTools: VirtualIdeTools;
}

export interface GenerateReviewingCommentInput {
  owner: string;
  repo: string;
  pullNumber: number;
  source: "issue_comment" | "pull_request" | "pull_request_review_comment" | "pull_request_review";
}

export interface ReviewLlmProvider {
  generateSuggestions(input: GenerateSuggestionInput): Promise<SuggestionResult>;
  generateReviewingComment(input: GenerateReviewingCommentInput): Promise<string | undefined>;
}

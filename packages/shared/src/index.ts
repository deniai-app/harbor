export type PullRequestAction = "opened" | "synchronize";

export interface GitHubPullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface SuggestionCandidate {
  path: string;
  line: number;
  body: string;
}

export interface SuggestionResult {
  suggestions: SuggestionCandidate[];
  overallComment?: string;
}

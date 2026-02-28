import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import type { SuggestionCandidate } from "@workspace/shared";
import { z } from "zod";
import {
  REVIEW_OK_COMMENT,
  type GenerateReviewingCommentInput,
  type GenerateSuggestionInput,
  type ReviewLlmProvider,
  type ReviewSuggestionResult,
} from "./types";

const ALL_TOOL_NAMES = ["list_dir", "get_changed_files", "read_file", "search_text", "read_guidelines", "scan_security_sinks", "preview_suggestion"] as const;

function buildSystemPrompt(): string {
  return [
    "You are a comprehensive pull request reviewer.",
    "Goal: find actionable issues across correctness, security, reliability, performance, and maintainability.",
    "Then propose tiny and safe GitHub suggested changes.",
    "Hard constraints:",
    "- First tool call must be list_dir(path='.', depth=3).",
    "- Only target added ('+') lines in diffs.",
    "- Do not propose out-of-diff edits.",
    "- Before finalizing suggestions, use preview_suggestion for each suggestion candidate to validate it can be applied safely to the file context.",
    "- Before returning final JSON, call read_guidelines and incorporate project policy/security instructions from SECURITY.md and README/CONTRIBUTING when relevant.",
    "- 1 suggestion code block must be <= 10 lines.",
    "- If multiple high-confidence improvements exist, return multiple suggestions.",
    "- Target 3-8 findings when safe; return fewer only if confidence is limited.",
    "- No spec changes, no large refactors, no new dependencies.",
    "- If uncertain, return no suggestion.",
    "- You only have read-only virtual IDE tools.",
    "- If guidance from read_guidelines is empty, do not guess policy-dependent rules; keep suggestions conservative.",
    "Review checklist (prioritize high impact first):",
    "- correctness/logic bugs, edge cases, error handling",
    "- security vulnerabilities and unsafe input handling",
    "- reliability/concurrency/resource leaks/timeouts",
    "- performance hot paths and unnecessary heavy operations",
    "- API contract/data validation/backward compatibility",
    "- maintainability/readability only when impactful",
    "Security checklist:",
    "- XSS priority: if input sources (req.body, req.query, req.params, env, headers, pathname, search params) flow into HTML sinks (innerHTML, dangerouslySetInnerHTML, document.write, template HTML assembly), classify as high priority and always suggest safe fixes.",
    "- authz/authn bypass, IDOR, privilege escalation",
    "- injection (SQL/command/template), XSS, CSRF, SSRF",
    "- path traversal, unsafe file handling, open redirect",
    "- secrets exposure, weak crypto/randomness, token/session flaws",
    "- deserialization/prototype pollution/ReDoS/race conditions",
    "- unsafe eval/shell usage and missing input validation",
    "Avoid style-only suggestions unless they materially improve quality.",
    "Return strict JSON:",
    '{"suggestions":[{"path":"string","line":123,"body":"optional title\n```suggestion\n...\n```"}],"overallStatus":"ok|uncertain","allowAutoApprove":false,"overallComment":"string"}',
    "overallStatus is required.",
    "Set overallStatus='ok' only when you are highly confident there are no actionable issues in changed lines.",
    "Set allowAutoApprove=true only when overallStatus='ok' and suggestions is empty.",
    "If suggestions is not empty, overallComment must be a short, concrete summary.",
    "If suggestions is empty and you are highly confident no actionable issue exists in changed lines, set overallComment exactly to:",
    `${REVIEW_OK_COMMENT}`,
    "If any security risk is detected or uncertain, set overallStatus='uncertain' and never use REVIEW_OK.",
    "body must contain a GitHub suggestion code block.",
  ].join("\n");
}

function buildUserPrompt(input: GenerateSuggestionInput): string {

  const changedSummary = input.changedFiles
    .map((file) => {
      const patchInfo = file.patch
        ? `patch:\n${file.patch.slice(0, 4000)}`
        : "patch: (omitted by GitHub API)";

      return [
        `file: ${file.filename}`,
        `status: ${file.status}`,
        `additions: ${file.additions}`,
        `deletions: ${file.deletions}`,
        patchInfo,
      ].join("\n");
    })
    .join("\n\n---\n\n");

  return [
    `Repository: ${input.owner}/${input.repo}`,
    `PR: #${input.pullNumber}`,
    `Head SHA: ${input.headSha}`,
    "Review only changed files with a comprehensive quality perspective.",
    "When patch is missing, use search_text and read_file sparingly.",
    "If no high-confidence safe suggestion exists, return empty suggestions.",
    "Prefer multiple independent suggestions across files when possible.",
    "Changed files:",
    changedSummary,
  ].join("\n\n");
}

function extractJson(content: string): string {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in LLM output.");
  }
  return content.slice(start, end + 1);
}

function dedupeConsecutiveDuplicateBlock(content: string): string {
  const lines = content.trim().split("\n").map((line) => line.trimEnd());
  if (lines.length < 2) {
    return content.trim();
  }

  for (let size = 1; size <= Math.floor(lines.length / 2); size += 1) {
    const first = lines.slice(0, size).join("\n");
    const second = lines.slice(size, size * 2).join("\n");
    if (size > 0 && first === second) {
      return first.trim();
    }

    const third = lines.slice(size * 2, size * 3).join("\n");
    if (third && first === third) {
      return first.trim();
    }
  }

  return content.trim();
}

function sanitizeSuggestionBody(body: string): string | null {
  if (!body.includes("```suggestion")) {
    return null;
  }

  const blockMatch = /```suggestion\n([\s\S]*?)\n```/m.exec(body);
  if (!blockMatch) {
    return null;
  }

  const blockContent = blockMatch[1];
  if (blockContent === undefined) {
    return null;
  }

  const cleanBlockContent = dedupeConsecutiveDuplicateBlock(blockContent);
  const lines = cleanBlockContent.split("\n");
  if (lines.length === 0 || lines.length > 10) {
    return null;
  }

  const before = body.slice(0, blockMatch.index ?? 0);
  const after = body.slice((blockMatch.index ?? 0) + blockMatch[0].length);
  const cleanBody = `${before}\n\`\`\`suggestion\n${cleanBlockContent}\n\`\`\`${after}`.trim();

  return cleanBody;
}

function extractSuggestionHeadline(body: string): string {
  const blockIndex = body.indexOf("```suggestion");
  const prefix = blockIndex >= 0 ? body.slice(0, blockIndex).trim() : body.trim();
  const firstLine = prefix.split("\n")[0];
  return (firstLine ?? "").trim();
}

function extractSuggestionBody(content: string): string {
  const blockMatch = /```suggestion\n([\s\S]*?)\n```/m.exec(content);
  if (!blockMatch || blockMatch[1] === undefined) {
    return content;
  }

  return blockMatch[1];
}

function previewSuggestion(params: {
  path: string;
  line: number;
  suggestionBody: string;
  virtualIdeTools: {
    call: (toolName: string, args: unknown) => Promise<unknown>;
  };
}): Promise<{ isSafe: boolean; reason: string; previewPatch?: string; before?: string; after?: string }> {
  const normalizedPath = params.path.replace(/^\/+/, "");
  const body = extractSuggestionBody(params.suggestionBody).replace(/\n+$/, "");
  const replacementLines = body.split("\n");

  if (!normalizedPath || replacementLines.length === 0) {
    return Promise.resolve({
      isSafe: false,
      reason: "invalid suggestion path or empty body",
    });
  }

  if (replacementLines.length > 10) {
    return Promise.resolve({
      isSafe: false,
      reason: "suggestion block exceeds 10 lines",
    });
  }

  const startLine = Math.max(1, params.line - 6);
  const endLine = startLine + 45;

  return params.virtualIdeTools
    .call("read_file", {
      path: normalizedPath,
      start_line: startLine,
      end_line: endLine,
    })
    .then((raw) => {
      const source = typeof raw === "string" ? raw : "";
      const fileLines = source
        .split("\n")
        .map((line) => {
          const marker = line.match(/^\\d+\| /);
          return marker ? line.slice(marker[0].length) : line;
        })
        .map((line) => line.replace(/\r$/, ""));

      const targetIndex = params.line - startLine;
      if (targetIndex < 0 || targetIndex >= fileLines.length) {
        return {
          isSafe: false,
          reason: `target line ${params.line} is outside preview window`,
        };
      }

      const currentLine = fileLines[targetIndex];
      if (currentLine === undefined) {
        return {
          isSafe: false,
          reason: `target line ${params.line} is unavailable for safe inline application`,
        };
      }

      const before = fileLines.join("\n");
      const applied = [...fileLines];
      applied.splice(targetIndex, 1, ...replacementLines);
      const after = applied.join("\n");

      const patch = [
        `@@ -${params.line},1 +${params.line},${replacementLines.length} @@`,
        `- ${currentLine}`,
        ...replacementLines.map((line) => `+ ${line}`),
      ].join("\n");

      return {
        isSafe: true,
        reason: "preview_ok",
        before,
        after,
        previewPatch: patch,
      };
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isSafe: false,
        reason: message,
      };
    });
}

function normalizeResult(raw: unknown): ReviewSuggestionResult {
  const payload = raw as {
    suggestions?: Array<{
      path?: string;
      line?: number;
      body?: string;
    }>;
    overallStatus?: string;
    allowAutoApprove?: boolean;
    overallComment?: string;
  };

  const suggestions: SuggestionCandidate[] = [];

  for (const item of payload.suggestions ?? []) {
    if (!item.path || typeof item.path !== "string") {
      continue;
    }

    if (!Number.isInteger(item.line) || (item.line ?? 0) <= 0) {
      continue;
    }

    if (!item.body || typeof item.body !== "string") {
      continue;
    }

    const safeBody = sanitizeSuggestionBody(item.body);
    if (!safeBody) {
      continue;
    }

    const line = item.line;
    if (line === undefined) {
      continue;
    }

    suggestions.push({
      path: item.path.replace(/^\.\//, ""),
      line,
      body: safeBody,
    });

    if (suggestions.length >= 999) {
      break;
    }
  }

  const overallStatus =
    payload.overallStatus === "ok"
      ? "ok"
      : payload.overallStatus === "uncertain"
        ? "uncertain"
        : undefined;

  return {
    suggestions,
    overallStatus,
    allowAutoApprove: payload.allowAutoApprove === true,
    overallComment:
      typeof payload.overallComment === "string" ? payload.overallComment.trim() : undefined,
  };
}

export class OpenAiReviewProvider implements ReviewLlmProvider {
  private readonly modelFactory: ReturnType<typeof createOpenAI>;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.modelFactory = createOpenAI({ apiKey });
  }

  async generateSuggestions(input: GenerateSuggestionInput): Promise<ReviewSuggestionResult> {
    const result = await generateText({
      model: this.modelFactory(this.model),
      temperature: 0.1,
      system: buildSystemPrompt(),
      prompt: buildUserPrompt(input),
      tools: {
        list_dir: tool({
          description:
            "List repository paths. This must be the first tool call in each PR review and use depth=3.",
          inputSchema: z.object({
            path: z.string().default("."),
            depth: z.number().int().default(3),
            max_entries: z.number().int().default(400),
          }),
          execute: async ({ path, depth, max_entries }) => {
            return input.virtualIdeTools.call("list_dir", { path, depth, max_entries });
          },
        }),
        get_changed_files: tool({
          description: "Get changed file list from GitHub PR API.",
          inputSchema: z.object({}),
          execute: async () => {
            return input.virtualIdeTools.call("get_changed_files", {});
          },
        }),
        read_file: tool({
          description: "Read line range from file. Restricted to changed files by default.",
          inputSchema: z.object({
            path: z.string(),
            start_line: z.number().int().positive(),
            end_line: z.number().int().positive(),
          }),
          execute: async ({ path, start_line, end_line }) => {
            return input.virtualIdeTools.call("read_file", { path, start_line, end_line });
          },
        }),
        search_text: tool({
          description: "Search text in changed files and return compact matches.",
          inputSchema: z.object({
            query: z.string(),
            max_results: z.number().int().positive().max(1000).default(200),
          }),
          execute: async ({ query, max_results }) => {
            return input.virtualIdeTools.call("search_text", { query, max_results });
          },
        }),
        read_guidelines: tool({
          description: "Read repository guidelines to apply project-specific review policy (security, style, and review rules).",
          inputSchema: z.object({}),
          execute: async () => {
            return input.virtualIdeTools.call("read_guidelines", {});
          },
        }),
        scan_security_sinks: tool({
          description: "Scan changed files for common security sinks (XSS, command injection, path traversal).",
          inputSchema: z.object({}),
          execute: async () => {
            return input.virtualIdeTools.call("scan_security_sinks", {});
          },
        }),
        preview_suggestion: tool({
          description: "Preview how a suggestion would look when applied to a file line for safety checks.",
          inputSchema: z.object({
            path: z.string(),
            line: z.number().int().positive(),
            suggestionBody: z.string(),
          }),
          execute: async ({ path, line, suggestionBody }) => {
            return previewSuggestion({
              path,
              line,
              suggestionBody,
              virtualIdeTools: input.virtualIdeTools,
            });
          },
        }),
      },
      stopWhen: stepCountIs(200),
      prepareStep: ({ stepNumber }) => {
        if (stepNumber === 0) {
          return {
            toolChoice: { type: "tool", toolName: "list_dir" },
            activeTools: ["list_dir"],
          };
        }

        if (stepNumber === 1) {
          return {
            toolChoice: { type: "tool", toolName: "read_guidelines" },
            activeTools: ["read_guidelines"],
          };
        }

        if (stepNumber === 2) {
          return {
            toolChoice: { type: "tool", toolName: "scan_security_sinks" },
            activeTools: ["scan_security_sinks"],
          };
        }

        return {
          toolChoice: "auto",
          activeTools: [...ALL_TOOL_NAMES],
        };
      },
      providerOptions: {
        openai: {
          parallelToolCalls: false,
        },
      },
    });

    const content = result.text;
    if (!content || typeof content !== "string") {
      return { suggestions: [], overallStatus: "uncertain", allowAutoApprove: false };
    }

    try {
      const parsed = JSON.parse(extractJson(content)) as unknown;
      const normalized = normalizeResult(parsed);

      const seen = new Set<string>();
      const validatedSuggestions: SuggestionCandidate[] = [];
      const MAX_PREVIEW_CHECKS = 120;
      let previewChecks = 0;
      for (const suggestion of normalized.suggestions) {
        if (previewChecks >= MAX_PREVIEW_CHECKS) {
          break;
        }
        const key = `${suggestion.path}:${suggestion.line}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        const preview = await previewSuggestion({
          path: suggestion.path,
          line: suggestion.line,
          suggestionBody: suggestion.body,
          virtualIdeTools: input.virtualIdeTools,
        });
        previewChecks += 1;
        if (preview.isSafe) {
          validatedSuggestions.push(suggestion);
          continue;
        }

        console.warn(
          `[review] Preview check failed for ${suggestion.path}:${suggestion.line} -> ${preview.reason}`,
        );
      }

      const filtered = {
        ...normalized,
        suggestions: validatedSuggestions,
      };

      if (!filtered.overallComment && filtered.suggestions.length > 0) {
        const fallbackOverallComment = await this.generateOverallComment({
          owner: input.owner,
          repo: input.repo,
          pullNumber: input.pullNumber,
          suggestions: filtered.suggestions,
        });

        return {
          ...filtered,
          overallComment: fallbackOverallComment,
        };
      }

      return filtered;
    } catch {
      return {
        suggestions: [],
        overallStatus: "uncertain",
        allowAutoApprove: false,
        overallComment: "LLM output could not be parsed into safe suggestions.",
      };
    }
  }

  async generateReviewingComment(
    input: GenerateReviewingCommentInput,
  ): Promise<string | undefined> {
    try {
      const result = await generateText({
        model: this.modelFactory(this.model),
        temperature: 0.3,
        system: [
          "You write concise markdown status comments for pull request review bots.",
          "Style should feel like a modern review assistant status update.",
          "Do not mention competitor products.",
          "No code fences.",
          "Output only markdown body content.",
          "Use one heading, one details block, and short bullet points.",
          "Keep it under 180 words.",
        ].join("\n"),
        prompt: [
          `Repository: ${input.owner}/${input.repo}`,
          `PR: #${input.pullNumber}`,
          `Trigger source: ${input.source}`,
          "Create an in-progress review status comment in English (or codebase used language).",
          "It should say the review started, what is currently happening, and what final output will follow.",
        ].join("\n\n"),
      });

      const text = result.text?.trim();
      return text && text.length > 0 ? text : undefined;
    } catch {
      return undefined;
    }
  }

  private async generateOverallComment(input: {
    owner: string;
    repo: string;
    pullNumber: number;
    suggestions: SuggestionCandidate[];
  }): Promise<string | undefined> {
    const suggestionSummary = input.suggestions
      .slice(0, 6)
      .map((item, index) => {
        const headline = extractSuggestionHeadline(item.body);
        return [
          `Suggestion ${index + 1}`,
          `- path: ${item.path}`,
          `- line: ${item.line}`,
          `- headline: ${headline || "(no title)"}`,
        ].join("\n");
      })
      .join("\n\n");

    try {
      const result = await generateText({
        model: this.modelFactory(this.model),
        temperature: 0.2,
        system: [
          "You write a concise pull request review summary.",
          "Output plain text only.",
          "2-3 short sentences.",
          "Mention concrete risk/themes from suggestions.",
          "No markdown, no code fences.",
        ].join("\n"),
        prompt: [
          `Repository: ${input.owner}/${input.repo}`,
          `PR: #${input.pullNumber}`,
          "Generate the top-level review body based on these suggestions:",
          suggestionSummary,
        ].join("\n\n"),
      });

      const text = result.text?.trim();
      return text && text.length > 0 ? text : undefined;
    } catch {
      return undefined;
    }
  }
}

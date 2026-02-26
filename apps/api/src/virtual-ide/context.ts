import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { GitHubPullRequestFile } from "@workspace/shared";

const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
  ".turbo",
]);

const DEFAULT_CONFIG_ALLOWLIST = new Set([
  "package.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "pnpm-workspace.yaml",
  "bunfig.toml",
  ".eslintrc.js",
  ".oxlintrc.json",
]);

function isHiddenSecretFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return (
    lower.startsWith(".env") ||
    lower.endsWith(".pem") ||
    lower === "id_rsa" ||
    lower.startsWith("credentials")
  );
}

function normalizeRepoRelativePath(inputPath: string): string {
  const path = inputPath.replaceAll("\\", "/").trim();
  if (path === "" || path === ".") {
    return ".";
  }

  if (path.startsWith("/") || /^[a-zA-Z]:\//.test(path)) {
    throw new Error("Absolute paths are not allowed.");
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error("Path traversal is not allowed.");
  }

  return segments.filter(Boolean).join("/");
}

interface ToolBudgets {
  listDir: number;
  readFile: number;
  searchText: number;
  readGuideline: number;
}

export interface VirtualIdeOptions {
  rootDir: string;
  changedFiles: GitHubPullRequestFile[];
  allowConfigRead: boolean;
}

interface SearchHit {
  path: string;
  line: number;
  excerpt: string;
}

export class VirtualIdeTools {
  private readonly changedFileSet: Set<string>;
  private readonly budgets: ToolBudgets = {
    listDir: 3,
    readFile: 8,
    searchText: 5,
    readGuideline: 2,
  };

  private totalReadLines = 0;
  private totalCalls = 0;

  constructor(private readonly options: VirtualIdeOptions) {
    this.changedFileSet = new Set(options.changedFiles.map((file) => file.filename));
  }

  async call(toolName: string, rawArgs: unknown): Promise<unknown> {
    if (this.totalCalls === 0 && toolName !== "list_dir") {
      throw new Error("list_dir must be called first once with depth=3.");
    }

    this.totalCalls += 1;

    switch (toolName) {
      case "list_dir": {
        const args = (rawArgs ?? {}) as { path?: string; depth?: number; max_entries?: number };
        const path = args.path ?? ".";
        const depth = args.depth ?? 3;
        const maxEntries = args.max_entries ?? 400;
        return this.listDir(path, depth, maxEntries);
      }
      case "get_changed_files":
        return this.getChangedFiles();
      case "read_file": {
        const args = (rawArgs ?? {}) as {
          path?: string;
          start_line?: number;
          end_line?: number;
        };
        if (!args.path || !args.start_line || !args.end_line) {
          throw new Error("read_file requires path, start_line, end_line.");
        }
        return this.readFile(args.path, args.start_line, args.end_line);
      }
      case "search_text": {
        const args = (rawArgs ?? {}) as { query?: string; max_results?: number };
        if (!args.query) {
          throw new Error("search_text requires query.");
        }
        return this.searchText(args.query, args.max_results ?? 20);
      }
      case "read_guidelines": {
        return this.readGuidelineDocs();
      }
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  private ensureBudget(tool: keyof ToolBudgets): void {
    this.budgets[tool] -= 1;
    if (this.budgets[tool] < 0) {
      throw new Error(`Tool budget exceeded for ${tool}.`);
    }
  }

  private resolveRepoPath(repoRelativePath: string): string {
    const normalized = normalizeRepoRelativePath(repoRelativePath);
    const candidate =
      normalized === "." ? this.options.rootDir : resolve(this.options.rootDir, normalized);

    const safeRoot = this.options.rootDir.endsWith(sep)
      ? this.options.rootDir
      : `${this.options.rootDir}${sep}`;
    if (candidate !== this.options.rootDir && !candidate.startsWith(safeRoot)) {
      throw new Error("Path escaped repository root.");
    }

    return candidate;
  }

  private isAllowedReadPath(path: string): boolean {
    if (this.changedFileSet.has(path)) {
      return true;
    }

    if (!this.options.allowConfigRead) {
      return false;
    }

    return DEFAULT_CONFIG_ALLOWLIST.has(basename(path));
  }

  private async listDir(path: string, depth: number, maxEntries: number): Promise<string[]> {
    this.ensureBudget("listDir");

    const resolvedDepth = Number.isFinite(depth) ? Math.max(0, Math.min(depth, 10)) : 3;
    const resolvedMax = Number.isFinite(maxEntries) ? Math.max(1, Math.min(maxEntries, 2000)) : 400;

    const relative = normalizeRepoRelativePath(path);
    const startDir = this.resolveRepoPath(relative);

    const output: string[] = [];

    const walk = async (
      absoluteDir: string,
      currentRelative: string,
      depthLeft: number,
    ): Promise<void> => {
      if (output.length >= resolvedMax || depthLeft < 0) {
        return;
      }

      const entries = await readdir(absoluteDir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (output.length >= resolvedMax) {
          return;
        }

        if (EXCLUDED_DIRS.has(entry.name) || isHiddenSecretFile(entry.name)) {
          continue;
        }

        const rel = currentRelative === "." ? entry.name : `${currentRelative}/${entry.name}`;
        output.push(entry.isDirectory() ? `${rel}/` : rel);

        if (entry.isDirectory() && depthLeft > 0) {
          await walk(join(absoluteDir, entry.name), rel, depthLeft - 1);
        }
      }
    };

    await walk(startDir, relative === "" ? "." : relative, resolvedDepth);
    return output;
  }

  private getChangedFiles(): GitHubPullRequestFile[] {
    return this.options.changedFiles;
  }

  private async readFile(path: string, startLine: number, endLine: number): Promise<string> {
    this.ensureBudget("readFile");

    if (endLine < startLine) {
      throw new Error("end_line must be >= start_line.");
    }

    const requestedLineCount = endLine - startLine + 1;
    if (requestedLineCount > 200) {
      throw new Error("read_file can read at most 200 lines per call.");
    }

    const relativePath = normalizeRepoRelativePath(path);
    if (!this.isAllowedReadPath(relativePath)) {
      throw new Error(`read_file is restricted to changed files by default: ${relativePath}`);
    }

    if (isHiddenSecretFile(basename(relativePath))) {
      throw new Error("Access denied.");
    }

    if (this.totalReadLines + requestedLineCount > 2000) {
      throw new Error("read_file total line budget exceeded (2000 lines per PR).");
    }

    const absolutePath = this.resolveRepoPath(relativePath);
    const content = await readFile(absolutePath, "utf-8");
    const lines = content.split(/\r?\n/);

    const startIndex = Math.max(1, startLine) - 1;
    const endIndex = Math.min(lines.length, endLine);

    const numberedLines: string[] = [];
    for (let i = startIndex; i < endIndex; i += 1) {
      numberedLines.push(`${i + 1}| ${lines[i] ?? ""}`);
    }

    this.totalReadLines += requestedLineCount;

    return numberedLines.join("\n");
  }

  private ensureGuidelineBudget(): void {
    this.budgets.readGuideline -= 1;
    if (this.budgets.readGuideline < 0) {
      throw new Error("Tool budget exceeded for read_guidelines.");
    }
  }

  private async readGuidelineDocs(): Promise<Record<string, string>> {
    this.ensureGuidelineBudget();

    const files = ["SECURITY.md", "PRODUCT.md", "README.md", "CONTRIBUTING.md"];
    const out: Record<string, string> = {};

    for (const file of files) {
      try {
        const absolutePath = this.resolveRepoPath(file);
        const content = await readFile(absolutePath, "utf-8");
        out[file] = content;
      } catch {
        out[file] = "";
      }
    }

    return out;
  }

  private async searchText(query: string, maxResults: number): Promise<SearchHit[]> {
    this.ensureBudget("searchText");

    const resolvedMax = Math.max(1, Math.min(maxResults, 50));
    const normalizedQuery = query.toLowerCase();
    const hits: SearchHit[] = [];

    for (const path of this.changedFileSet) {
      if (isHiddenSecretFile(basename(path))) {
        continue;
      }

      let lines: string[];
      try {
        const absolutePath = this.resolveRepoPath(path);
        const fileStat = await stat(absolutePath);
        if (!fileStat.isFile()) {
          continue;
        }

        const content = await readFile(absolutePath, "utf-8");
        lines = content.split(/\r?\n/);
      } catch {
        continue;
      }

      for (let index = 0; index < lines.length; index += 1) {
        const lineText = lines[index] ?? "";
        if (!lineText.toLowerCase().includes(normalizedQuery)) {
          continue;
        }

        hits.push({
          path,
          line: index + 1,
          excerpt: lineText.trim().slice(0, 240),
        });

        if (hits.length >= resolvedMax) {
          return hits;
        }
      }
    }

    return hits;
  }
}

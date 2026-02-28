import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
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

const SECURITY_SCAN_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);

const USER_INPUT_MARKERS: Array<{ hint: string; re: RegExp }> = [
  { hint: "req.body", re: /\breq\.(?:body|rawBody)\b/i },
  { hint: "req.query", re: /\breq\.(?:query)\b/i },
  { hint: "req.params", re: /\breq\.(?:params)\b/i },
  { hint: "req.headers", re: /\breq\.(?:headers|header)\b/i },
  { hint: "req.cookies", re: /\breq\.(?:cookies)\b/i },
  { hint: "req.path", re: /\breq\.(?:path|url|originalUrl)\b/i },
  { hint: "ctx", re: /\b(?:ctx|c)\.(?:body|query|params)\b/i },
  { hint: "search params", re: /\b(?:URLSearchParams|location\.search|window\.location|document\.location)\b/i },
  { hint: "request body/query object", re: /\b(?:body|query|params|cookies)\[[^\]]+\]/i },
];

const SANITIZER_PATTERNS = [
  /\bDOMPurify\b/i,
  /\bsanitize(?:Html|HTML)?\b/i,
  /\bhtmlEscape\b/i,
  /\bencodeURIComponent\b/i,
];

const COMMAND_CALL_METHODS = ["exec", "spawn", "execSync", "spawnSync"] as const;

type SecurityScanConfidence = "low" | "medium" | "high";

type ChildProcessAliasSet = {
  objectAliases: Set<string>;
  functionAliases: Set<string>;
};

interface ToolBudgets {
  listDir: number;
  readFile: number;
  searchText: number;
  readGuideline: number;
  securityScan: number;
}

interface SearchHit {
  path: string;
  line: number;
  excerpt: string;
}

interface SecuritySinkFinding {
  path: string;
  line: number;
  category: string;
  excerpt: string;
  confidence: SecurityScanConfidence;
  sourceHint?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

function stripScanNoise(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/, "")
    .trim();
}

export interface VirtualIdeOptions {
  rootDir: string;
  changedFiles: GitHubPullRequestFile[];
  allowConfigRead: boolean;
}

export class VirtualIdeTools {
  private readonly changedFileSet: Set<string>;
  private readonly budgets: ToolBudgets = {
    listDir: 200,
    readFile: 2000,
    searchText: 200,
    readGuideline: 20,
    securityScan: 50,
  };

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
      case "scan_security_sinks": {
        return this.scanSecuritySinks();
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

  private isScannableFile(path: string): boolean {
    const extension = extname(path).toLowerCase();
    return SECURITY_SCAN_EXTENSIONS.has(extension);
  }

  private hasUserInputSource(line: string): boolean {
    return USER_INPUT_MARKERS.some(({ re }) => re.test(line));
  }

  private extractUserInputHint(line: string): string | undefined {
    for (const { hint, re } of USER_INPUT_MARKERS) {
      if (re.test(line)) {
        return hint;
      }
    }
    return undefined;
  }

  private inferConfidence(line: string): SecurityScanConfidence {
    if (this.hasUserInputSource(line)) {
      return "high";
    }

    if (SANITIZER_PATTERNS.some((re) => re.test(line))) {
      return "low";
    }

    return "medium";
  }

  private collectChildProcessAliases(lines: string[]): ChildProcessAliasSet {
    const objectAliases = new Set(["child_process"]);
    const functionAliases = new Set<string>();

    const importDefault = /import\s+([A-Za-z_$][\w$]*)\s+from\s+["']child_process["']/g;
    const namespaceImport = /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']child_process["']/g;
    const namedImport = /import\s*\{([^}]+)\}\s*from\s+["']child_process["']/g;
    const cjsRequireAlias = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(["']child_process["']\)/g;
    const cjsRequireDestructure = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(["']child_process["']\)/g;

    for (const rawLine of lines) {
      let match: RegExpExecArray | null;

      while ((match = importDefault.exec(rawLine)) !== null) {
        const alias = match[1];
        if (alias) {
          objectAliases.add(alias);
        }
      }

      while ((match = namespaceImport.exec(rawLine)) !== null) {
        const alias = match[1];
        if (alias) {
          objectAliases.add(alias);
        }
      }

      while ((match = cjsRequireAlias.exec(rawLine)) !== null) {
        const alias = match[1];
        if (alias) {
          objectAliases.add(alias);
        }
      }

      while ((match = namedImport.exec(rawLine)) !== null) {
        const imports = match[1];
        if (!imports) {
          continue;
        }

        for (const token of imports.split(",")) {
          const t = token.trim();
          if (!t) {
            continue;
          }

          const asMatch = /([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/i.exec(t);
          if (asMatch) {
            functionAliases.add(asMatch[2] ?? "");
            continue;
          }

          functionAliases.add(t.split(/\s+/)[0] ?? "");
        }
      }

      while ((match = cjsRequireDestructure.exec(rawLine)) !== null) {
        const imports = match[1];
        if (!imports) {
          continue;
        }

        for (const token of imports.split(",")) {
          const t = token.trim();
          if (!t) {
            continue;
          }

          const asMatch = /([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/i.exec(t);
          if (asMatch) {
            functionAliases.add(asMatch[2] ?? "");
            continue;
          }

          functionAliases.add(t.split(/\s+/)[0] ?? "");
        }
      }
    }

    return { objectAliases, functionAliases };
  }

  private hasChildProcessCall(line: string, aliases: ChildProcessAliasSet): boolean {
    const objectPattern = Array.from(aliases.objectAliases)
      .map((alias) => escapeRegExp(alias))
      .join("|");

    if (objectPattern) {
      const objectAliasRegex = new RegExp(
        `\\b(?:${objectPattern})\\.(?:${COMMAND_CALL_METHODS.join("|")})\\s*\\(`,
      );
      if (objectAliasRegex.test(line)) {
        return true;
      }
    }

    const functionPattern = Array.from(aliases.functionAliases)
      .map((alias) => escapeRegExp(alias))
      .join("|");

    if (!functionPattern) {
      return false;
    }

    const functionAliasRegex = new RegExp(`\\b(?:${functionPattern})\\s*\\(`);
    return functionAliasRegex.test(line);
  }

  private async listDir(path: string, depth: number, maxEntries: number): Promise<string[]> {
    this.ensureBudget("listDir");

    const resolvedDepth = Number.isFinite(depth) ? Math.max(0, Math.min(depth, 24)) : 3;
    const resolvedMax = Number.isFinite(maxEntries) ? Math.max(1, Math.min(maxEntries, 10000)) : 400;

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

    const relativePath = normalizeRepoRelativePath(path);
    if (!this.isAllowedReadPath(relativePath)) {
      throw new Error(`read_file is restricted to changed files by default: ${relativePath}`);
    }

    if (isHiddenSecretFile(basename(relativePath))) {
      throw new Error("Access denied.");
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

    return numberedLines.join("\n");
  }

  private async scanSecuritySinks(): Promise<SecuritySinkFinding[]> {
    this.ensureBudget("securityScan");

    const findings: SecuritySinkFinding[] = [];
    const seen = new Set<string>();

    const xssPatterns = [
      /\binnerHTML\s*=/,
      /\bdangerouslySetInnerHTML\b/,
      /\bsrcdoc\s*=/,
      /\bdocument\.write\s*\(/,
    ];

    const injectionPatterns = [
      /\beval\s*\(/,
      /\bnew\s+Function\s*\(/,
      /\b(?:setTimeout|setInterval)\s*\(\s*["'`]/,
    ];

    const pathTraversalPatterns = [
      /\bpath\.join\s*\(/,
      /\bpath\.resolve\s*\(/,
      /\bpath\.normalize\s*\(/,
    ];

    for (const path of this.changedFileSet) {
      if (!this.isScannableFile(path)) {
        continue;
      }

      try {
        const absolutePath = this.resolveRepoPath(path);
        const fileStat = await stat(absolutePath);
        if (!fileStat.isFile()) {
          continue;
        }

        const content = await readFile(absolutePath, "utf-8");
        const lines = content.split(/\r?\n/);
        const childProcessAliases = this.collectChildProcessAliases(lines);

        for (let i = 0; i < lines.length; i += 1) {
          const line = stripScanNoise(lines[i] ?? "");
          if (!line) {
            continue;
          }

          const hasSource = this.hasUserInputSource(line);
          const confidence = this.inferConfidence(line);
          const sourceHint = this.extractUserInputHint(line);

          if (xssPatterns.some((pattern) => pattern.test(line))) {
            if (confidence === "low") {
              continue;
            }

            const key = `${path}:${i + 1}:xss`;
            if (!seen.has(key)) {
              findings.push({
                path,
                line: i + 1,
                category: "xss",
                excerpt: line.slice(0, 260),
                confidence: hasSource ? "high" : "medium",
                sourceHint,
              });
              seen.add(key);
            }

            continue;
          }

          if (injectionPatterns.some((pattern) => pattern.test(line))) {
            if (confidence === "low") {
              continue;
            }

            const key = `${path}:${i + 1}:injection`;
            if (!seen.has(key)) {
              findings.push({
                path,
                line: i + 1,
                category: "injection",
                excerpt: line.slice(0, 260),
                confidence,
                sourceHint,
              });
              seen.add(key);
            }

            continue;
          }

          if (this.hasChildProcessCall(line, childProcessAliases)) {
            const key = `${path}:${i + 1}:cmd`;
            if (!seen.has(key)) {
              findings.push({
                path,
                line: i + 1,
                category: "cmd-injection",
                excerpt: line.slice(0, 260),
                confidence: hasSource ? "high" : "medium",
                sourceHint,
              });
              seen.add(key);
            }

            continue;
          }

          if (pathTraversalPatterns.some((pattern) => pattern.test(line)) && hasSource) {
            const key = `${path}:${i + 1}:path`;
            if (!seen.has(key)) {
              findings.push({
                path,
                line: i + 1,
                category: "path-traversal",
                excerpt: line.slice(0, 260),
                confidence: "high",
                sourceHint,
              });
              seen.add(key);
            }
          }
        }
      } catch {
        continue;
      }
    }

    return findings;
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

  private ensureGuidelineBudget(): void {
    this.budgets.readGuideline -= 1;
    if (this.budgets.readGuideline < 0) {
      throw new Error("Tool budget exceeded for read_guidelines.");
    }
  }

  private async searchText(query: string, maxResults: number): Promise<SearchHit[]> {
    this.ensureBudget("searchText");

    const resolvedMax = Math.max(1, Math.min(maxResults, 1000));
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

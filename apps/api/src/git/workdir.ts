import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT_TMP = "/tmp/harbor";
const MAX_GIT_RETRIES = 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runGitCommand(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      env: process.env,
      maxBuffer: 1024 * 1024 * 10,
    });

    return stdout.trim();
  } catch (error: unknown) {
    const redact = (value: string) => value.replace(/https:\/\/[^@\s]+@/g, "https://***@");
    const message =
      error instanceof Error
        ? redact(error.message)
        : "Unknown git execution error while running git command";
    const command = ["git", ...args.map(redact)].join(" ");
    const details = `Failed command: ${command}${cwd ? ` (cwd: ${cwd})` : ""}`;
    throw new Error(`${details}\n${message}`);
      error instanceof Error
        ? error.message
        : "Unknown git execution error while running git command";
    const command = ["git", ...args].join(" ");
    const details = `Failed command: ${command}${cwd ? ` (cwd: ${cwd})` : ""}`;
    throw new Error(`${details}\n${message}`);
  }
}

async function runGitWithRetry(args: string[], cwd?: string, attempt = 1): Promise<string> {
  try {
    return await runGitCommand(args, cwd);
  } catch (error) {
    if (attempt > MAX_GIT_RETRIES) {
      throw error;
    }

    console.warn(
      `[workdir] Git command failed (attempt ${attempt}/${MAX_GIT_RETRIES + 1}). Retrying...`,
      error,
    );
    await sleep(200 * attempt * attempt);
    return runGitWithRetry(args, cwd, attempt + 1);
  }
}

function withTokenInCloneUrl(cloneUrl: string, token: string): string {
  const url = new URL(cloneUrl);
  if (url.protocol !== "https:") {
    throw new Error("Only https clone URLs are supported.");
  }

  url.username = "x-access-token";
  url.password = token;
  return url.toString();
}

function buildDefaultCloneUrl(repoOwner: string, repoName: string): string {
  return `https://github.com/${repoOwner}/${repoName}.git`;
}

function resolveCloneUrl(params: {
  cloneUrl?: string;
  repoOwner: string;
  repoName: string;
}): string {
  const raw = params.cloneUrl?.trim();
  if (!raw) {
    console.warn(
      `[workdir] clone_url missing for ${params.repoOwner}/${params.repoName}. Falling back to canonical GitHub URL.`,
    );
    return buildDefaultCloneUrl(params.repoOwner, params.repoName);
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") {
      throw new Error(`Unsupported clone URL protocol: ${parsed.protocol}`);
    }
    return parsed.toString();
  } catch (error) {
    console.warn(
      `[workdir] Invalid clone_url for ${params.repoOwner}/${params.repoName}. Falling back to canonical GitHub URL.`,
      error,
    );
    return buildDefaultCloneUrl(params.repoOwner, params.repoName);
  }
}

export interface WorkdirSession {
  jobId: string;
  workdir: string;
  cleanup: () => Promise<void>;
}

export async function createWorkdirSession(params: {
  token: string;
  repoOwner: string;
  repoName: string;
  pullNumber: number;
  headSha?: string;
  cloneUrl?: string;
}): Promise<WorkdirSession> {
  if (!params.repoOwner || !params.repoName) {
    throw new Error("Missing repository owner/name for workdir session.");
  }
  if (!Number.isInteger(params.pullNumber) || params.pullNumber <= 0) {
    throw new Error(`Invalid pull request number: ${params.pullNumber}`);
  }

  const jobId = randomUUID();
  const workdir = join(ROOT_TMP, jobId);

  await mkdir(ROOT_TMP, { recursive: true });

  const cloneUrl = resolveCloneUrl({
    cloneUrl: params.cloneUrl,
    repoOwner: params.repoOwner,
    repoName: params.repoName,
  });
  const authCloneUrl = withTokenInCloneUrl(cloneUrl, params.token);

  try {
    await runGitWithRetry(["clone", "--depth", "1", "--no-tags", authCloneUrl, workdir]);

    const pullHeadRef = `refs/pull/${params.pullNumber}/head`;
    await runGitWithRetry([
      "-C",
      workdir,
      "fetch",
      "--depth",
      "1",
      "origin",
      `+${pullHeadRef}:${pullHeadRef}`,
    ]);
    await runGitWithRetry(["-C", workdir, "checkout", "--detach", pullHeadRef]);

    if (params.headSha) {
      const currentHead = await runGitWithRetry(["-C", workdir, "rev-parse", "HEAD"]);
      if (currentHead !== params.headSha) {
        console.warn(
          `[workdir] pull ref head mismatch for ${params.repoOwner}/${params.repoName}#${params.pullNumber}. expected=${params.headSha} actual=${currentHead}. Retrying with SHA fetch.`,
        );
        await runGitWithRetry(["-C", workdir, "fetch", "--depth", "1", "origin", params.headSha]);
        await runGitWithRetry(["-C", workdir, "checkout", "--detach", "FETCH_HEAD"]);

        const fallbackHead = await runGitWithRetry(["-C", workdir, "rev-parse", "HEAD"]);
        if (fallbackHead !== params.headSha) {
          throw new Error(
            `[workdir] Failed to checkout expected head SHA for ${params.repoOwner}/${params.repoName}#${params.pullNumber}: expected=${params.headSha} actual=${fallbackHead}`,
          );
        }
      }
    }
  } catch (error) {
    await rm(workdir, { recursive: true, force: true });
    throw error;
  }

  return {
    jobId,
    workdir,
    cleanup: async () => {
      await rm(workdir, { recursive: true, force: true });
    },
  };
}

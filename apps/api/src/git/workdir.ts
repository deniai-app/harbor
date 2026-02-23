import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT_TMP = "/tmp/harbor";

async function runGit(args: string[], cwd?: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    env: process.env,
    maxBuffer: 1024 * 1024 * 10,
  });

  if (stderr && stderr.toLowerCase().includes("fatal")) {
    throw new Error(stderr);
  }

  return stdout.trim();
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
    // Keep explicit repository.clone_url when available; fallback is only for missing/invalid payload values.
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

  await runGit(["clone", "--depth", "1", "--no-tags", authCloneUrl, workdir]);

  const pullHeadRef = `refs/pull/${params.pullNumber}/head`;
  await runGit(["-C", workdir, "fetch", "--depth", "1", "origin", `+${pullHeadRef}:${pullHeadRef}`]);
  await runGit(["-C", workdir, "checkout", "--detach", pullHeadRef]);

  if (params.headSha) {
    const currentHead = await runGit(["-C", workdir, "rev-parse", "HEAD"]);
    if (currentHead !== params.headSha) {
      // Defensive fallback: keep old SHA-based fetch path when pull ref and expected SHA diverge.
      console.warn(
        `[workdir] pull ref head mismatch for ${params.repoOwner}/${params.repoName}#${params.pullNumber}. expected=${params.headSha} actual=${currentHead}. Retrying with SHA fetch.`,
      );
      await runGit(["-C", workdir, "fetch", "--depth", "1", "origin", params.headSha]);
      await runGit(["-C", workdir, "checkout", "--detach", "FETCH_HEAD"]);

      const fallbackHead = await runGit(["-C", workdir, "rev-parse", "HEAD"]);
      if (fallbackHead !== params.headSha) {
        throw new Error(
          `[workdir] Failed to checkout expected head SHA for ${params.repoOwner}/${params.repoName}#${params.pullNumber}: expected=${params.headSha} actual=${fallbackHead}`,
        );
      }
    }
  }

  return {
    jobId,
    workdir,
    cleanup: async () => {
      await rm(workdir, { recursive: true, force: true });
    },
  };
}

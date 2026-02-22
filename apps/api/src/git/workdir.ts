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

export interface WorkdirSession {
  jobId: string;
  workdir: string;
  cleanup: () => Promise<void>;
}

export async function createWorkdirSession(params: {
  cloneUrl: string;
  token: string;
  headSha: string;
}): Promise<WorkdirSession> {
  const jobId = randomUUID();
  const workdir = join(ROOT_TMP, jobId);

  await mkdir(ROOT_TMP, { recursive: true });

  const authCloneUrl = withTokenInCloneUrl(params.cloneUrl, params.token);

  await runGit(["clone", "--depth", "1", "--no-tags", authCloneUrl, workdir]);

  const currentHead = await runGit(["-C", workdir, "rev-parse", "HEAD"]);
  if (currentHead !== params.headSha) {
    await runGit(["-C", workdir, "fetch", "--depth", "1", "origin", params.headSha]);
    await runGit(["-C", workdir, "checkout", "--detach", "FETCH_HEAD"]);
  }

  return {
    jobId,
    workdir,
    cleanup: async () => {
      await rm(workdir, { recursive: true, force: true });
    },
  };
}

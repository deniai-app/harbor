import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { VirtualIdeTools } from "../src/virtual-ide/context";

function makeChangedFile(filename: string) {
  return {
    filename,
    status: "modified",
    additions: 0,
    deletions: 0,
  };
}

describe("VirtualIdeTools security sink scan", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    for (const root of temporaryRoots) {
      await rm(root, { recursive: true, force: true });
    }
    temporaryRoots.length = 0;
  });

  it("returns high-confidence xss findings when user input flows into a sink", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "harbor-ide-"));
    temporaryRoots.push(rootDir);

    const filePath = join(rootDir, "src", "insecure.ts");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      ["const container = document.body;", "container.innerHTML = req.body.html;"].join("\n"),
    );

    const tools = new VirtualIdeTools({
      rootDir,
      changedFiles: [makeChangedFile("src/insecure.ts")],
      allowConfigRead: false,
    });

    await tools.call("list_dir", { path: ".", depth: 2, max_entries: 100 });
    const findings = (await tools.call("scan_security_sinks", {})) as Array<{
      path: string;
      line: number;
      category: string;
      confidence: "low" | "medium" | "high";
      sourceHint?: string;
    }>;

    const xss = findings.find((item) => item.category === "xss");
    expect(xss).toBeDefined();
    expect(xss).toMatchObject({
      path: "src/insecure.ts",
      line: 2,
      confidence: "high",
      sourceHint: "req.body",
    });
  });

  it("filters common false positives (sanitize-wrapped assignment and function-based timers)", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "harbor-ide-"));
    temporaryRoots.push(rootDir);

    const filePath = join(rootDir, "src", "benign.ts");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      [
        'import { readFileSync } from "fs";',
        "setTimeout(() => rotate(), 1000);",
        "const html = sanitize(req.body.html);",
        "output.innerHTML = sanitize(`<span>${html}</span>`);",
        'const p = path.join("/app", "static", "config");',
      ].join("\n"),
    );

    const tools = new VirtualIdeTools({
      rootDir,
      changedFiles: [makeChangedFile("src/benign.ts")],
      allowConfigRead: false,
    });

    await tools.call("list_dir", { path: ".", depth: 2, max_entries: 100 });
    const findings = (await tools.call("scan_security_sinks", {})) as Array<{
      category: string;
      confidence: "low" | "medium" | "high";
      path: string;
    }>;

    expect(findings.find((item) => item.category === "injection")).toBeUndefined();
    expect(findings.find((item) => item.category === "path-traversal")).toBeUndefined();
  });

  it("detects command and path traversal sinks only when user input context exists", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "harbor-ide-"));
    temporaryRoots.push(rootDir);

    const filePath = join(rootDir, "src", "commands.ts");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      [
        'import { execSync } from "child_process";',
        'import * as path from "path";',
        'const safePath = path.join(process.cwd(), "public", "assets");',
        "const userPath = path.join(process.cwd(), req.query.file);",
        "execSync(req.body.command);",
      ].join("\n"),
    );

    const tools = new VirtualIdeTools({
      rootDir,
      changedFiles: [makeChangedFile("src/commands.ts")],
      allowConfigRead: false,
    });

    await tools.call("list_dir", { path: ".", depth: 2, max_entries: 100 });
    const findings = (await tools.call("scan_security_sinks", {})) as Array<{
      category: string;
      confidence: "low" | "medium" | "high";
    }>;

    const commandFindings = findings.filter((item) => item.category === "cmd-injection");
    const pathFindings = findings.filter((item) => item.category === "path-traversal");

    expect(commandFindings).toHaveLength(1);
    expect(pathFindings).toHaveLength(1);
    expect(commandFindings[0]?.confidence).toBe("high");
    expect(pathFindings[0]?.confidence).toBe("high");
  });
});

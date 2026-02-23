import { describe, expect, it } from "vitest";
import { buildAddedLineToPositionMap, extractPatchByFile } from "../src/diff/patch";

describe("extractPatchByFile", () => {
  it("extracts patch blocks per file and keeps multiple hunks", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      "-const a = 1;",
      "+const a = 2;",
      "@@ -10,1 +10,2 @@",
      " console.log(a);",
      "+console.log('x');",
      "diff --git a/src/b.ts b/src/b.ts",
      "index 3333333..4444444 100644",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "Binary files a/src/b.ts and b/src/b.ts differ",
      "diff --git a/src/c.ts b/src/c.ts",
      "index 5555555..6666666 100644",
      "--- a/src/c.ts",
      "+++ b/src/c.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "\\ No newline at end of file",
    ].join("\n");

    const patchMap = extractPatchByFile(diff);

    expect(patchMap.get("src/a.ts")).toBe(
      [
        "@@ -1,2 +1,2 @@",
        "-const a = 1;",
        "+const a = 2;",
        "@@ -10,1 +10,2 @@",
        " console.log(a);",
        "+console.log('x');",
      ].join("\n"),
    );
    expect(patchMap.has("src/b.ts")).toBe(false);
    expect(patchMap.get("src/c.ts")).toContain("\\ No newline at end of file");
  });

  it("returns empty map when no hunk exists", () => {
    const diff = [
      "diff --git a/README.md b/README.md",
      "index 1234567..89abcde 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "Binary files a/README.md and b/README.md differ",
    ].join("\n");

    const patchMap = extractPatchByFile(diff);
    expect(patchMap.size).toBe(0);
  });
});

describe("buildAddedLineToPositionMap", () => {
  it("maps added line numbers to diff positions with context/deletions", () => {
    const patch = [
      "@@ -1,3 +1,4 @@",
      " line1",
      "-line2",
      "+line2-updated",
      " line3",
      "+line4",
    ].join("\n");

    const map = buildAddedLineToPositionMap(patch);

    expect(map.get(2)).toBe(3);
    expect(map.get(4)).toBe(5);
    expect(map.has(3)).toBe(false);
  });

  it("handles multiple hunks", () => {
    const patch = ["@@ -1,1 +1,1 @@", "-a", "+b", "@@ -10,2 +10,3 @@", " c", "+d", " e"].join("\n");

    const map = buildAddedLineToPositionMap(patch);

    expect(map.get(1)).toBe(2);
    expect(map.get(11)).toBe(4);
  });

  it("ignores no-newline markers", () => {
    const patch = ["@@ -1 +1 @@", "-old", "+new", "\\ No newline at end of file"].join("\n");

    const map = buildAddedLineToPositionMap(patch);
    expect(map.get(1)).toBe(2);
    expect(map.size).toBe(1);
  });

  it("returns empty map when patch has no hunk header", () => {
    const patch = ["--- a/a.ts", "+++ b/a.ts", "+line"].join("\n");
    const map = buildAddedLineToPositionMap(patch);
    expect(map.size).toBe(0);
  });
});

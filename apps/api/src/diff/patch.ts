export function extractPatchByFile(diffText: string): Map<string, string> {
  const lines = diffText.split("\n");
  const result = new Map<string, string>();

  let currentPath: string | undefined;
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentPath || currentLines.length === 0) {
      return;
    }

    const firstHunkIndex = currentLines.findIndex((line) => line.startsWith("@@ "));
    if (firstHunkIndex === -1) {
      return;
    }

    const patch = currentLines.slice(firstHunkIndex).join("\n").trimEnd();
    if (patch) {
      result.set(currentPath, patch);
    }
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      currentLines = [];

      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      currentPath = match?.[2];
      continue;
    }

    if (currentPath) {
      currentLines.push(line);
    }
  }

  flush();
  return result;
}

function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) {
    return null;
  }

  const oldStartRaw = match[1];
  const newStartRaw = match[2];
  if (!oldStartRaw || !newStartRaw) {
    return null;
  }

  return {
    oldStart: Number.parseInt(oldStartRaw, 10),
    newStart: Number.parseInt(newStartRaw, 10),
  };
}

export function buildAddedLineToPositionMap(patch: string): Map<number, number> {
  const map = new Map<number, number>();

  let newLine = 0;
  let hasActiveHunk = false;
  let position = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@ ")) {
      const hunk = parseHunkHeader(line);
      if (!hunk) {
        continue;
      }

      newLine = hunk.newStart;
      hasActiveHunk = true;
      continue;
    }

    if (!hasActiveHunk) {
      continue;
    }

    if (line.startsWith("\\")) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      position += 1;
      map.set(newLine, position);
      newLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      position += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      position += 1;
      newLine += 1;
      continue;
    }
  }

  return map;
}

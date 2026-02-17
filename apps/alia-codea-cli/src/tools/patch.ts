import * as fs from 'fs/promises';
import * as path from 'path';

interface Hunk {
  oldStart: number;
  oldLines: string[];
  newLines: string[];
}

interface FilePatch {
  filePath: string;
  hunks: Hunk[];
}

interface PatchResult {
  success: boolean;
  results: Array<{ file: string; success: boolean; message: string }>;
}

export function parsePatch(patchText: string): FilePatch[] {
  const files: FilePatch[] = [];
  const lines = patchText.split('\n');
  let currentFile: FilePatch | null = null;
  let currentHunk: Hunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // File header: --- a/path or --- path
    if (line.startsWith('--- ')) {
      // Next line should be +++ b/path
      const nextLine = lines[i + 1];
      if (nextLine && nextLine.startsWith('+++ ')) {
        let filePath = nextLine.slice(4).trim();
        // Remove b/ prefix
        if (filePath.startsWith('b/')) {
          filePath = filePath.slice(2);
        }
        currentFile = { filePath, hunks: [] };
        files.push(currentFile);
        i++; // skip the +++ line
        continue;
      }
    }

    // Hunk header: @@ -start,count +start,count @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
    if (hunkMatch && currentFile) {
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldLines: [],
        newLines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    // Hunk content
    if (currentHunk) {
      if (line.startsWith('-')) {
        currentHunk.oldLines.push(line.slice(1));
      } else if (line.startsWith('+')) {
        currentHunk.newLines.push(line.slice(1));
      } else if (line.startsWith(' ')) {
        // Context line - appears in both old and new
        currentHunk.oldLines.push(line.slice(1));
        currentHunk.newLines.push(line.slice(1));
      }
    }
  }

  return files;
}

function findHunkPosition(fileLines: string[], hunkOldLines: string[], expectedStart: number, drift: number = 20): number {
  // Try exact position first (0-indexed)
  const start = expectedStart - 1;
  if (matchesAt(fileLines, hunkOldLines, start)) {
    return start;
  }

  // Fuzzy search within ±drift lines
  for (let offset = 1; offset <= drift; offset++) {
    if (matchesAt(fileLines, hunkOldLines, start + offset)) {
      return start + offset;
    }
    if (matchesAt(fileLines, hunkOldLines, start - offset)) {
      return start - offset;
    }
  }

  return -1;
}

function matchesAt(fileLines: string[], hunkOldLines: string[], position: number): boolean {
  if (position < 0 || position + hunkOldLines.length > fileLines.length) {
    return false;
  }

  for (let i = 0; i < hunkOldLines.length; i++) {
    // Normalize whitespace for comparison
    const fileLine = fileLines[position + i].trimEnd();
    const hunkLine = hunkOldLines[i].trimEnd();
    if (fileLine !== hunkLine) {
      return false;
    }
  }

  return true;
}

export async function applyPatch(patchText: string, basePath: string): Promise<PatchResult> {
  const filePatches = parsePatch(patchText);
  const results: PatchResult['results'] = [];
  let allSuccess = true;

  for (const filePatch of filePatches) {
    const absolutePath = path.resolve(basePath, filePatch.filePath);

    try {
      let content: string;
      try {
        content = await fs.readFile(absolutePath, 'utf-8');
      } catch {
        // File doesn't exist - if all hunks are additions, create it
        const allAdditions = filePatch.hunks.every((h) => h.oldLines.length === 0);
        if (allAdditions) {
          const newContent = filePatch.hunks.map((h) => h.newLines.join('\n')).join('\n');
          await fs.mkdir(path.dirname(absolutePath), { recursive: true });
          await fs.writeFile(absolutePath, newContent, 'utf-8');
          results.push({ file: filePatch.filePath, success: true, message: 'Created new file' });
          continue;
        }
        throw new Error(`File not found: ${filePatch.filePath}`);
      }

      let fileLines = content.split('\n');

      // Apply hunks in reverse order to preserve line numbers
      const sortedHunks = [...filePatch.hunks].sort((a, b) => b.oldStart - a.oldStart);

      for (const hunk of sortedHunks) {
        const position = findHunkPosition(fileLines, hunk.oldLines, hunk.oldStart);
        if (position === -1) {
          throw new Error(
            `Could not find match for hunk at line ${hunk.oldStart} in ${filePatch.filePath}`
          );
        }

        // Replace old lines with new lines
        fileLines.splice(position, hunk.oldLines.length, ...hunk.newLines);
      }

      await fs.writeFile(absolutePath, fileLines.join('\n'), 'utf-8');
      results.push({
        file: filePatch.filePath,
        success: true,
        message: `Applied ${filePatch.hunks.length} hunk(s)`,
      });
    } catch (error: unknown) {
      allSuccess = false;
      const message = error instanceof Error ? error.message : String(error);
      results.push({ file: filePatch.filePath, success: false, message });
    }
  }

  return { success: allSuccess, results };
}

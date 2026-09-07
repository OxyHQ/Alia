/**
 * Unified-diff parsing and application for the `apply_patch` tool.
 *
 * Every input here is written by a language model and applied to the user's
 * working tree, in `auto-edit` and `full-auto` with no human in between. That
 * is what decides the three rules this file is built around.
 *
 * ## 1. A path out of the patch never escapes the base directory
 *
 * The previous version did `path.resolve(basePath, filePatch.filePath)` and
 * wrote to whatever came back. `path.resolve` lets an ABSOLUTE path win
 * outright, so it was not only `../../..` that escaped — git's own header for
 * a deleted file is `+++ /dev/null`, which resolved to `/dev/null` and left
 * the base directory without anything looking wrong. `resolveInside` is now
 * the only way a path becomes absolute here, and it returns `null` rather than
 * a path it cannot vouch for.
 *
 * ## 2. Hunk bodies are consumed by their DECLARED counts
 *
 * The previous version treated any line starting with `--- ` as the beginning
 * of a new file header. A deleted line whose own content starts with `-- ` —
 * an SQL comment, a CLI flag in a code block — is written as `--- ` in a diff,
 * so deleting one silently ended the current file patch and started a bogus
 * one. `@@ -a,b +c,d @@` says exactly how many lines belong to the hunk, so
 * the counts decide, and the header pattern is only consulted once a hunk is
 * complete. Patches that omit the counts fall back to the permissive scan,
 * which is where the old ambiguity survives and cannot be resolved.
 *
 * ## 3. A hunk that could apply in two places applies in neither
 *
 * The fuzzy search exists because a model's line numbers drift. It used to
 * return the FIRST position within ±20 lines that matched, which in a file
 * with a repeated block (two identical error branches, a repeated import
 * group) silently patched the wrong one and reported success. Now every
 * candidate in the window is collected: an exact-position match always wins,
 * a single fuzzy match is accepted, and two or more is an error that names the
 * ambiguity instead of picking.
 */

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
  /** `--- /dev/null`: the patch creates this file. */
  creates: boolean;
  /** `+++ /dev/null`: the patch deletes this file. */
  deletes: boolean;
  /** A `\ No newline at end of file` marker appeared in this file's hunks. */
  noTrailingNewline: boolean;
}

interface PatchResult {
  success: boolean;
  results: Array<{ file: string; success: boolean; message: string }>;
}

/** How far from its declared line number a hunk may be found. */
const DRIFT = 20;

/**
 * The path half of a `---`/`+++` header.
 *
 * Git appends a tab and a timestamp to these in some formats, and prefixes the
 * two sides with `a/` and `b/`. `/dev/null` is reported as-is because which
 * side it is on is what distinguishes a creation from a deletion.
 */
function headerPath(raw: string): string {
  let value = raw.split('\t')[0].trim();
  if (value === '/dev/null') return value;
  if (value.startsWith('a/') || value.startsWith('b/')) value = value.slice(2);
  return value;
}

/**
 * Resolve `relative` under `basePath`, or `null` if it would land outside.
 *
 * `path.relative` rather than a string prefix test: a prefix test says
 * `/repo-backup` is inside `/repo`. An absolute `relative` is caught by the
 * same check, because `path.relative` from the base to an unrelated absolute
 * path starts with `..`.
 */
export function resolveInside(
  basePath: string,
  relative: string,
  /** Whether the base directory ITSELF is an acceptable answer. False for a
   *  file target (a patch cannot write to a directory); true for the directory
   *  tools, whose default argument is `.`. */
  allowBase = false,
): string | null {
  const base = path.resolve(basePath);
  const target = path.resolve(base, relative);
  const rel = path.relative(base, target);
  if (rel === '') return allowBase ? target : null;
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  return target;
}

export function parsePatch(patchText: string): FilePatch[] {
  const files: FilePatch[] = [];
  const lines = patchText.split('\n');
  let currentFile: FilePatch | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // File header: `--- a/path` immediately followed by `+++ b/path`.
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const oldPath = headerPath(line.slice(4));
      const newPath = headerPath(lines[i + 1].slice(4));
      const creates = oldPath === '/dev/null';
      const deletes = newPath === '/dev/null';
      // On a deletion the surviving name is the OLD side; everywhere else it
      // is the new one. Taking `+++` unconditionally is what made a deletion
      // resolve to `/dev/null`.
      const filePath = deletes ? oldPath : newPath;
      currentFile = { filePath, hunks: [], creates, deletes, noTrailingNewline: false };
      files.push(currentFile);
      i += 2;
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      const hunk: Hunk = { oldStart: parseInt(hunkMatch[1], 10), oldLines: [], newLines: [] };
      // A hunk header without counts means one line on that side.
      const bounded = hunkMatch[2] !== undefined || hunkMatch[4] !== undefined;
      let oldRemaining = hunkMatch[2] === undefined ? 1 : parseInt(hunkMatch[2], 10);
      let newRemaining = hunkMatch[4] === undefined ? 1 : parseInt(hunkMatch[4], 10);
      i++;

      while (i < lines.length) {
        const body = lines[i];

        // `\ No newline at end of file` — metadata, not content. Tested BEFORE
        // the exhausted-counts break, because git emits it after the final
        // content line of the hunk, when both counts have already reached
        // zero: breaking first drops the marker and silently re-adds the
        // trailing newline the patch just said was absent.
        if (body.startsWith('\\')) {
          currentFile.noTrailingNewline = true;
          i++;
          continue;
        }

        if (bounded && oldRemaining <= 0 && newRemaining <= 0) break;

        // Once the declared counts are exhausted (or were never declared), a
        // header pair or a new hunk ends this hunk. Checked HERE rather than
        // at the top so a `--- ` that is really a deleted `-- ` line is
        // consumed as content while the counts still expect it.
        if (!bounded || oldRemaining > 0 || newRemaining > 0) {
          if (
            (body.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) ||
            /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(body)
          ) {
            if (!bounded) break;
          }
        }

        if (body.startsWith('-')) {
          hunk.oldLines.push(body.slice(1));
          oldRemaining--;
        } else if (body.startsWith('+')) {
          hunk.newLines.push(body.slice(1));
          newRemaining--;
        } else if (body.startsWith(' ')) {
          hunk.oldLines.push(body.slice(1));
          hunk.newLines.push(body.slice(1));
          oldRemaining--;
          newRemaining--;
        } else if (body === '' && bounded && (oldRemaining > 0 || newRemaining > 0)) {
          // An empty context line. Git writes a single space, but editors and
          // model output routinely strip trailing whitespace; the declared
          // counts are what make it safe to read this as content.
          hunk.oldLines.push('');
          hunk.newLines.push('');
          oldRemaining--;
          newRemaining--;
        } else {
          break;
        }
        i++;
      }

      currentFile.hunks.push(hunk);
      continue;
    }

    i++;
  }

  return files;
}

/**
 * Where `hunkOldLines` sits in `fileLines`, or `-1` if nowhere, or `-2` if in
 * more than one place within the drift window.
 */
function findHunkPosition(
  fileLines: string[],
  hunkOldLines: string[],
  expectedStart: number,
  drift: number = DRIFT,
): number {
  const start = expectedStart - 1;

  // A pure insertion anchors on nothing, so there is nothing to search for and
  // nothing that could be ambiguous — it goes exactly where it says.
  if (hunkOldLines.length === 0) {
    return Math.min(Math.max(start, 0), fileLines.length);
  }

  if (matchesAt(fileLines, hunkOldLines, start)) return start;

  const candidates: number[] = [];
  for (let offset = 1; offset <= drift; offset++) {
    if (matchesAt(fileLines, hunkOldLines, start + offset)) candidates.push(start + offset);
    if (matchesAt(fileLines, hunkOldLines, start - offset)) candidates.push(start - offset);
  }

  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return -2;
  return -1;
}

function matchesAt(fileLines: string[], hunkOldLines: string[], position: number): boolean {
  if (position < 0 || position + hunkOldLines.length > fileLines.length) {
    return false;
  }

  for (let i = 0; i < hunkOldLines.length; i++) {
    // Trailing whitespace is normalized: a model reproducing context lines
    // rarely preserves it, and it is not what the hunk is about.
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
    const absolutePath = resolveInside(basePath, filePatch.filePath);
    if (absolutePath === null) {
      allSuccess = false;
      results.push({
        file: filePatch.filePath,
        success: false,
        message: `Refused: the patch targets a path outside the working directory (${filePatch.filePath})`,
      });
      continue;
    }

    try {
      if (filePatch.deletes) {
        await fs.rm(absolutePath, { force: true });
        results.push({ file: filePatch.filePath, success: true, message: 'Deleted file' });
        continue;
      }

      let content: string;
      try {
        content = await fs.readFile(absolutePath, 'utf-8');
      } catch {
        // Absent file — creatable when the patch says so, or when every hunk
        // is pure addition and so describes no prior content.
        const allAdditions = filePatch.hunks.every((h) => h.oldLines.length === 0);
        if (filePatch.creates || allAdditions) {
          const body = filePatch.hunks.map((h) => h.newLines.join('\n')).join('\n');
          const newContent = filePatch.noTrailingNewline || body === '' ? body : `${body}\n`;
          await fs.mkdir(path.dirname(absolutePath), { recursive: true });
          await fs.writeFile(absolutePath, newContent, 'utf-8');
          results.push({ file: filePatch.filePath, success: true, message: 'Created new file' });
          continue;
        }
        throw new Error(`File not found: ${filePatch.filePath}`);
      }

      const fileLines = content.split('\n');

      // Apply hunks in reverse order to preserve line numbers
      const sortedHunks = [...filePatch.hunks].sort((a, b) => b.oldStart - a.oldStart);

      for (const hunk of sortedHunks) {
        const position = findHunkPosition(fileLines, hunk.oldLines, hunk.oldStart);
        if (position === -2) {
          throw new Error(
            `Hunk at line ${hunk.oldStart} in ${filePatch.filePath} matches more than one place; ` +
              'add more context lines so it is unambiguous',
          );
        }
        if (position === -1) {
          throw new Error(
            `Could not find match for hunk at line ${hunk.oldStart} in ${filePatch.filePath}`,
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

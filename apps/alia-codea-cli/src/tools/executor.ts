import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { applyPatch } from './patch.js';

const execAsync = promisify(exec);

interface ToolResult {
  success: boolean;
  result: string;
}

export async function executeTool(name: string, args: Record<string, any>): Promise<ToolResult> {
  try {
    switch (name) {
      case 'read_file':
        return await readFile(args.path);
      case 'write_file':
        return await writeFile(args.path, args.content);
      case 'edit_file':
        return await editFile(args.path, args.old_text, args.new_text);
      case 'apply_patch':
        return await applyPatchTool(args.patch);
      case 'list_files':
        return await listFiles(args.path, args.recursive);
      case 'search_files':
        return await searchFiles(args.pattern, args.path, args.file_pattern, args.context_lines, args.max_results);
      case 'run_command':
        return await runCommand(args.command, args.cwd);
      default:
        return { success: false, result: `Unknown tool: ${name}` };
    }
  } catch (error: any) {
    return { success: false, result: error.message };
  }
}

async function readFile(filePath: string): Promise<ToolResult> {
  const absolutePath = path.resolve(process.cwd(), filePath);
  const content = await fs.readFile(absolutePath, 'utf-8');
  return { success: true, result: content };
}

async function writeFile(filePath: string, content: string): Promise<ToolResult> {
  const absolutePath = path.resolve(process.cwd(), filePath);

  // Ensure directory exists
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, 'utf-8');

  return { success: true, result: `File written: ${filePath}` };
}

async function editFile(filePath: string, oldText: string, newText: string): Promise<ToolResult> {
  const absolutePath = path.resolve(process.cwd(), filePath);
  const content = await fs.readFile(absolutePath, 'utf-8');

  // Try exact match first
  if (content.includes(oldText)) {
    const newContent = content.replace(oldText, newText);
    await fs.writeFile(absolutePath, newContent, 'utf-8');
    return { success: true, result: `File edited: ${filePath}` };
  }

  // Try whitespace-normalized match
  const normalizedOld = oldText.replace(/\s+/g, ' ').trim();
  const lines = content.split('\n');
  let matchStart = -1;
  let matchEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    for (let j = i; j < lines.length; j++) {
      const block = lines.slice(i, j + 1).join('\n');
      if (block.replace(/\s+/g, ' ').trim() === normalizedOld) {
        matchStart = i;
        matchEnd = j;
        break;
      }
    }
    if (matchStart >= 0) break;
  }

  if (matchStart >= 0) {
    const newLines = [...lines.slice(0, matchStart), ...newText.split('\n'), ...lines.slice(matchEnd + 1)];
    await fs.writeFile(absolutePath, newLines.join('\n'), 'utf-8');
    return { success: true, result: `File edited (fuzzy match): ${filePath}` };
  }

  return { success: false, result: `Text not found in file: "${oldText.slice(0, 50)}..."` };
}

async function applyPatchTool(patchText: string): Promise<ToolResult> {
  const result = await applyPatch(patchText, process.cwd());
  const summary = result.results
    .map((r) => `${r.success ? '✓' : '✗'} ${r.file}: ${r.message}`)
    .join('\n');
  return { success: result.success, result: summary };
}

async function listFiles(dirPath: string = '.', recursive: boolean = false): Promise<ToolResult> {
  const absolutePath = path.resolve(process.cwd(), dirPath);

  if (recursive) {
    const files: string[] = [];
    async function walk(dir: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(absolutePath, fullPath);

        // Skip common ignored directories
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
          continue;
        }

        if (entry.isDirectory()) {
          files.push(relativePath + '/');
          await walk(fullPath);
        } else {
          files.push(relativePath);
        }
      }
    }
    await walk(absolutePath);
    return { success: true, result: files.join('\n') };
  } else {
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    const files = entries.map(e => e.name + (e.isDirectory() ? '/' : ''));
    return { success: true, result: files.join('\n') };
  }
}

async function searchFiles(
  pattern: string,
  dirPath: string = '.',
  filePattern?: string,
  contextLines: number = 2,
  maxResults: number = 50
): Promise<ToolResult> {
  const absolutePath = path.resolve(process.cwd(), dirPath);

  // Try ripgrep first
  try {
    const rgArgs = [
      '--json',
      '-C', String(contextLines),
      '-m', String(maxResults),
      '--no-heading',
    ];

    if (filePattern) {
      rgArgs.push('-g', filePattern);
    }

    rgArgs.push('--', pattern, absolutePath);

    const { stdout } = await execAsync(`rg ${rgArgs.map(a => `'${a}'`).join(' ')}`, {
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30000,
    });

    // Parse rg --json output
    const results: string[] = [];
    const lines = stdout.trim().split('\n');

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.type === 'match') {
          const relPath = path.relative(absolutePath, data.data.path.text);
          const lineNum = data.data.line_number;
          const text = data.data.lines.text.trimEnd();
          results.push(`${relPath}:${lineNum}: ${text}`);
        } else if (data.type === 'context') {
          const relPath = path.relative(absolutePath, data.data.path.text);
          const lineNum = data.data.line_number;
          const text = data.data.lines.text.trimEnd();
          results.push(`${relPath}:${lineNum}  ${text}`);
        }
      } catch {
        // Skip malformed JSON lines
      }
    }

    if (results.length === 0) {
      return { success: true, result: 'No matches found.' };
    }

    return { success: true, result: results.join('\n') };
  } catch {
    // ripgrep not available or failed, use built-in
  }

  // Built-in fallback
  const regex = new RegExp(pattern, 'gi');
  const results: Array<{ file: string; line: number; text: string; isMatch: boolean }> = [];
  const fileMatchCounts = new Map<string, number>();

  async function searchDir(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
        continue;
      }

      if (entry.isDirectory()) {
        await searchDir(fullPath);
      } else {
        if (filePattern) {
          const ext = path.extname(entry.name);
          const patternExt = filePattern.replace('*', '');
          if (ext !== patternExt && !entry.name.match(filePattern.replace('*', '.*'))) {
            continue;
          }
        }

        try {
          const content = await fs.readFile(fullPath, 'utf-8');

          // Skip binary files
          if (content.includes('\0')) continue;

          const lines = content.split('\n');
          const matchIndices: number[] = [];

          lines.forEach((line, index) => {
            regex.lastIndex = 0;
            if (regex.test(line)) {
              matchIndices.push(index);
            }
          });

          if (matchIndices.length > 0) {
            const relativePath = path.relative(absolutePath, fullPath);
            fileMatchCounts.set(relativePath, matchIndices.length);

            for (const idx of matchIndices) {
              const start = Math.max(0, idx - contextLines);
              const end = Math.min(lines.length - 1, idx + contextLines);

              for (let i = start; i <= end; i++) {
                results.push({
                  file: relativePath,
                  line: i + 1,
                  text: lines[i].trimEnd(),
                  isMatch: i === idx,
                });
              }
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  await searchDir(absolutePath);

  if (results.length === 0) {
    return { success: true, result: 'No matches found.' };
  }

  const formatted = results
    .slice(0, maxResults * (1 + contextLines * 2))
    .map((r) => `${r.file}:${r.line}${r.isMatch ? ':' : ' '} ${r.text}`)
    .join('\n');

  const totalMatches = Array.from(fileMatchCounts.values()).reduce((a, b) => a + b, 0);
  const footer = `\n(${totalMatches} matches in ${fileMatchCounts.size} files)`;

  return { success: true, result: formatted + footer };
}

async function runCommand(command: string, cwd?: string): Promise<ToolResult> {
  const workingDir = cwd ? path.resolve(process.cwd(), cwd) : process.cwd();

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: workingDir,
      maxBuffer: 1024 * 1024,
      timeout: 60000
    });

    const output = stdout + (stderr ? `\nStderr:\n${stderr}` : '');
    return { success: true, result: output || 'Command completed successfully.' };
  } catch (error: any) {
    return {
      success: false,
      result: error.stdout + (error.stderr ? `\nStderr:\n${error.stderr}` : '') || error.message
    };
  }
}

export function formatToolCall(name: string, args: Record<string, any>): string {
  const labels: Record<string, string> = {
    read_file: 'Reading file',
    write_file: 'Writing file',
    edit_file: 'Editing file',
    apply_patch: 'Applying patch',
    list_files: 'Listing files',
    search_files: 'Searching files',
    run_command: 'Running command'
  };

  const label = labels[name] || name;
  const argStr = Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 50) : v}`)
    .join(', ');

  return `${chalk.cyan('→')} ${chalk.bold(label)}: ${chalk.gray(argStr)}`;
}

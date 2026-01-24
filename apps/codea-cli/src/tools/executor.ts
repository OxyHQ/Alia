import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { glob } from 'fs/promises';
import chalk from 'chalk';

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
      case 'list_files':
        return await listFiles(args.path, args.recursive);
      case 'search_files':
        return await searchFiles(args.pattern, args.path, args.file_pattern);
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

  if (!content.includes(oldText)) {
    return { success: false, result: `Text not found in file: "${oldText.slice(0, 50)}..."` };
  }

  const newContent = content.replace(oldText, newText);
  await fs.writeFile(absolutePath, newContent, 'utf-8');

  return { success: true, result: `File edited: ${filePath}` };
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

async function searchFiles(pattern: string, dirPath: string = '.', filePattern?: string): Promise<ToolResult> {
  const absolutePath = path.resolve(process.cwd(), dirPath);
  const regex = new RegExp(pattern, 'gi');
  const results: string[] = [];

  async function searchDir(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Skip common ignored directories
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
        continue;
      }

      if (entry.isDirectory()) {
        await searchDir(fullPath);
      } else {
        // Check file pattern
        if (filePattern) {
          const ext = path.extname(entry.name);
          const patternExt = filePattern.replace('*', '');
          if (ext !== patternExt && !entry.name.match(filePattern.replace('*', '.*'))) {
            continue;
          }
        }

        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          const lines = content.split('\n');

          lines.forEach((line, index) => {
            if (regex.test(line)) {
              const relativePath = path.relative(absolutePath, fullPath);
              results.push(`${relativePath}:${index + 1}: ${line.trim()}`);
            }
          });
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

  return { success: true, result: results.slice(0, 100).join('\n') + (results.length > 100 ? `\n... and ${results.length - 100} more` : '') };
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

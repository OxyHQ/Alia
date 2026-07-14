import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function buildSystemMessage(codebaseContext: string, projectInstructions?: string): string {
  let systemMessage = `You are Codea, an expert AI coding assistant created by OxyAI. You help developers write, debug, refactor, and understand code directly in their terminal.

## Core Principles
- Be concise and direct. Avoid unnecessary explanations unless asked.
- Write clean, idiomatic, well-structured code following best practices.
- Consider edge cases, error handling, and security implications.
- Match the existing code style and conventions of the project.

## Tools Available
You have powerful tools to interact with the user's workspace:

- **read_file**: Read file contents. Use to understand existing code before making changes.
- **write_file**: Create new files or completely rewrite existing ones.
- **edit_file**: Make precise, targeted changes using exact text match and replace.
- **apply_patch**: Apply unified diff patches to files. Preferred for multi-line or multi-file changes. Supports fuzzy line matching.
- **list_files**: Explore directory structure. Use to understand project layout.
- **search_files**: Find text/patterns across the codebase with context lines. Uses ripgrep when available.
- **run_command**: Execute shell commands (build, test, git, npm, etc.)

## Best Practices
1. **Read before writing**: Always read relevant files before modifying them.
2. **Minimal changes**: Make the smallest change necessary to accomplish the task.
3. **Preserve style**: Match existing formatting, naming conventions, and patterns.
4. **Prefer apply_patch**: For multi-line edits, use apply_patch with unified diff format.
5. **Explain when helpful**: For complex changes, briefly explain the approach.

## Response Style
- Use markdown for formatting code blocks, lists, and emphasis.
- For code explanations, be thorough but focused.
- For code changes, be precise and action-oriented.
- If unsure about requirements, ask clarifying questions.
- When a tool call fails, do NOT repeat or reformat the error message. Briefly acknowledge the issue and try an alternative approach or move on.
- Only use the tools listed above. Do NOT attempt to call tools that are not in your tool set.`;

  if (projectInstructions) {
    systemMessage += `\n\n## Project Instructions (from CODEA.md)\n${projectInstructions}`;
  }

  if (codebaseContext) {
    systemMessage += `\n\n## Current Codebase Context\n${codebaseContext}`;
  }

  return systemMessage;
}

export async function loadProjectInstructions(): Promise<string> {
  const parts: string[] = [];

  // 1. Global: ~/.codea/CODEA.md
  const home = process.env.HOME || '';
  if (home) {
    const globalPath = path.join(home, '.codea', 'CODEA.md');
    try {
      const content = await fs.readFile(globalPath, 'utf-8');
      if (content.trim()) {
        parts.push(`# Global Instructions (~/.codea/CODEA.md)\n${content.trim()}`);
      }
    } catch {
      // No global instructions
    }
  }

  // 2. Project root: {git_root}/CODEA.md
  let gitRoot = '';
  try {
    const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd: process.cwd() });
    gitRoot = stdout.trim();
  } catch {
    // Not a git repo
  }

  if (gitRoot) {
    const projectPath = path.join(gitRoot, 'CODEA.md');
    try {
      const content = await fs.readFile(projectPath, 'utf-8');
      if (content.trim()) {
        parts.push(`# Project Instructions (CODEA.md)\n${content.trim()}`);
      }
    } catch {
      // No project instructions
    }
  }

  // 3. Directory-level: {cwd}/CODEA.md (if different from git root)
  const cwd = process.cwd();
  if (cwd !== gitRoot) {
    const dirPath = path.join(cwd, 'CODEA.md');
    try {
      const content = await fs.readFile(dirPath, 'utf-8');
      if (content.trim()) {
        parts.push(`# Directory Instructions (./CODEA.md)\n${content.trim()}`);
      }
    } catch {
      // No directory instructions
    }
  }

  return parts.join('\n\n---\n\n');
}

export async function getCodebaseContext(): Promise<string> {
  const cwd = process.cwd();
  const contextParts: string[] = [];

  // Try to get project info from package.json
  try {
    const pkgPath = path.join(cwd, 'package.json');
    const pkgContent = await fs.readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(pkgContent);
    contextParts.push(`Project: ${pkg.name || 'Unknown'} (${pkg.description || 'No description'})`);

    if (pkg.dependencies) {
      const deps = Object.keys(pkg.dependencies).slice(0, 10);
      contextParts.push(`Dependencies: ${deps.join(', ')}${Object.keys(pkg.dependencies).length > 10 ? '...' : ''}`);
    }
  } catch {
    // No package.json
  }

  // Try to get git info
  try {
    const { stdout: branch } = await execAsync('git branch --show-current', { cwd });
    contextParts.push(`Git branch: ${branch.trim()}`);

    const { stdout: status } = await execAsync('git status --porcelain', { cwd });
    const changedFiles = status.trim().split('\n').filter(Boolean).length;
    if (changedFiles > 0) {
      contextParts.push(`Uncommitted changes: ${changedFiles} files`);
    }
  } catch {
    // Not a git repo
  }

  // Get directory structure (limited)
  try {
    const files = await getRelevantFiles(cwd);
    if (files.length > 0) {
      contextParts.push(`\nKey files:\n${files.map(f => `- ${f}`).join('\n')}`);
    }
  } catch {
    // Can't read directory
  }

  return contextParts.join('\n');
}

async function getRelevantFiles(dir: string, maxFiles: number = 20): Promise<string[]> {
  const relevantFiles: string[] = [];
  const relevantExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.md'];
  const ignoreDirs = ['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', 'coverage'];

  async function walk(currentDir: string, depth: number = 0): Promise<void> {
    if (depth > 3 || relevantFiles.length >= maxFiles) return;

    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        if (relevantFiles.length >= maxFiles) break;

        if (ignoreDirs.includes(entry.name)) continue;

        const fullPath = path.join(currentDir, entry.name);
        const relativePath = path.relative(dir, fullPath);

        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1);
        } else {
          const ext = path.extname(entry.name);
          if (relevantExtensions.includes(ext) || entry.name === 'README.md' || entry.name === 'package.json') {
            relevantFiles.push(relativePath);
          }
        }
      }
    } catch {
      // Can't read directory
    }
  }

  await walk(dir);
  return relevantFiles;
}

import * as vscode from 'vscode';

// Tool definitions in OpenAI format (for backward compatibility)
export const fileTools = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Use this to examine code, configuration files, or any text file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to read, relative to the workspace root'
          },
          start_line: {
            type: 'number',
            description: 'Optional starting line number (1-indexed). If not specified, reads from the beginning.'
          },
          end_line: {
            type: 'number',
            description: 'Optional ending line number (1-indexed). If not specified, reads to the end.'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or completely overwrite an existing file with new content.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to write, relative to the workspace root'
          },
          content: {
            type: 'string',
            description: 'The complete content to write to the file'
          }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Make targeted edits to a file by replacing specific text. Use this for small, precise changes.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to edit, relative to the workspace root'
          },
          old_text: {
            type: 'string',
            description: 'The exact text to find and replace (must match exactly including whitespace)'
          },
          new_text: {
            type: 'string',
            description: 'The new text to replace it with'
          }
        },
        required: ['path', 'old_text', 'new_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file from the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to delete, relative to the workspace root'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories in a given path. If no path provided, lists workspace root. Use this to explore the project structure.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The directory path to list, relative to the workspace root. Use "." for root. If not provided, lists workspace root.'
          },
          recursive: {
            type: 'boolean',
            description: 'If true, list files recursively. Default is false.'
          },
          pattern: {
            type: 'string',
            description: 'Optional glob pattern to filter files (e.g., "**/*.ts")'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for text or patterns across files in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The text or regex pattern to search for'
          },
          path: {
            type: 'string',
            description: 'Optional directory to search in, relative to workspace root. Defaults to entire workspace.'
          },
          include: {
            type: 'string',
            description: 'Optional glob pattern to include files (e.g., "**/*.ts")'
          },
          exclude: {
            type: 'string',
            description: 'Optional glob pattern to exclude files'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command in the workspace. Use for running tests, builds, git commands, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute'
          },
          cwd: {
            type: 'string',
            description: 'Optional working directory, relative to workspace root'
          }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_file',
      description: 'Open a file in the VS Code editor and show it to the user. Use this when the user asks to "open", "show", or "display" a file. This is different from read_file - this actually opens the file in a tab.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to open, relative to the workspace root (e.g., "README.md", "src/index.ts")'
          },
          line: {
            type: 'number',
            description: 'Optional line number to scroll to (1-indexed)'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_mode',
      description: 'Change the assistant operating mode. Use when user requests a mode change like "switch to edit mode" or "go yolo".',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['ask', 'edit', 'plan', 'yolo'],
            description: 'The mode to switch to. ask=confirm destructive ops, edit=make changes directly, plan=outline then execute, yolo=full autonomous'
          }
        },
        required: ['mode']
      }
    }
  }
];

// Tool execution functions
export class ToolExecutor {
  private workspaceRootUri: vscode.Uri | undefined;

  constructor() {
    const folders = vscode.workspace.workspaceFolders;
    this.workspaceRootUri = folders?.[0]?.uri;
  }

  private resolveUri(relativePath: string | undefined): vscode.Uri {
    if (!this.workspaceRootUri) {
      throw new Error('No workspace folder open');
    }
    // Default to current workspace if no path provided
    if (!relativePath || relativePath === '' || relativePath === '.') {
      return this.workspaceRootUri;
    }
    // Handle absolute paths (starts with /)
    if (relativePath.startsWith('/')) {
      return vscode.Uri.file(relativePath);
    }
    return vscode.Uri.joinPath(this.workspaceRootUri, relativePath);
  }

  private getRelativePath(uri: vscode.Uri): string {
    if (!this.workspaceRootUri) {
      return uri.fsPath;
    }
    const workspacePath = this.workspaceRootUri.fsPath;
    const filePath = uri.fsPath;
    if (filePath.startsWith(workspacePath)) {
      return filePath.slice(workspacePath.length + 1); // +1 for the separator
    }
    return filePath;
  }

  async execute(toolName: string, args: any): Promise<{ success: boolean; result: string }> {
    try {
      switch (toolName) {
        case 'read_file':
          return await this.readFile(args);
        case 'write_file':
          return await this.writeFile(args);
        case 'edit_file':
          return await this.editFile(args);
        case 'delete_file':
          return await this.deleteFile(args);
        case 'list_files':
          return await this.listFiles(args);
        case 'search_files':
          return await this.searchFiles(args);
        case 'run_command':
          return await this.runCommand(args);
        case 'open_file':
          return await this.openFile(args);
        default:
          return { success: false, result: `Unknown tool: ${toolName}` };
      }
    } catch (error: any) {
      return { success: false, result: `Error: ${error.message}` };
    }
  }

  private async readFile(args: { path: string; start_line?: number; end_line?: number }): Promise<{ success: boolean; result: string }> {
    try {
      const fileUri = this.resolveUri(args.path);
      const contentBytes = await vscode.workspace.fs.readFile(fileUri);
      const content = new TextDecoder().decode(contentBytes);
      const lines = content.split('\n');

      if (args.start_line || args.end_line) {
        const start = (args.start_line || 1) - 1;
        const end = args.end_line || lines.length;
        const selectedLines = lines.slice(start, end);
        return {
          success: true,
          result: selectedLines.map((line, i) => `${start + i + 1}: ${line}`).join('\n')
        };
      }

      // Add line numbers for context
      const numberedContent = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
      return { success: true, result: numberedContent };
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        return { success: false, result: `File not found: ${args.path}` };
      }
      throw error;
    }
  }

  private async writeFile(args: { path: string; content: string }): Promise<{ success: boolean; result: string }> {
    const fileUri = this.resolveUri(args.path);
    const contentBytes = new TextEncoder().encode(args.content);

    // vscode.workspace.fs.writeFile creates parent directories automatically
    await vscode.workspace.fs.writeFile(fileUri, contentBytes);

    // Open the file in the editor
    const doc = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(doc, { preview: false });

    return { success: true, result: `Successfully wrote to ${args.path}` };
  }

  private async editFile(args: { path: string; old_text: string; new_text: string }): Promise<{ success: boolean; result: string }> {
    try {
      const fileUri = this.resolveUri(args.path);
      const contentBytes = await vscode.workspace.fs.readFile(fileUri);
      const content = new TextDecoder().decode(contentBytes);

      if (!content.includes(args.old_text)) {
        return { success: false, result: `Could not find the specified text in ${args.path}. Make sure the text matches exactly including whitespace.` };
      }

      const newContent = content.replace(args.old_text, args.new_text);
      await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(newContent));

      // Open the file in the editor
      const doc = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(doc, { preview: false });

      return { success: true, result: `Successfully edited ${args.path}` };
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        return { success: false, result: `File not found: ${args.path}` };
      }
      throw error;
    }
  }

  private async deleteFile(args: { path: string }): Promise<{ success: boolean; result: string }> {
    try {
      const fileUri = this.resolveUri(args.path);
      await vscode.workspace.fs.delete(fileUri);
      return { success: true, result: `Successfully deleted ${args.path}` };
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        return { success: false, result: `File not found: ${args.path}` };
      }
      throw error;
    }
  }

  private async listFiles(args: { path: string; recursive?: boolean; pattern?: string }): Promise<{ success: boolean; result: string }> {
    try {
      const dirUri = this.resolveUri(args.path);

      if (args.pattern) {
        // Use VS Code's findFiles for glob patterns
        const pattern = new vscode.RelativePattern(dirUri, args.pattern);
        const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 1000);
        const relativePaths = files.map(f => this.getRelativePath(f));
        return { success: true, result: relativePaths.join('\n') || 'No files found' };
      }

      const listDir = async (dir: vscode.Uri, prefix: string = ''): Promise<string[]> => {
        const entries = await vscode.workspace.fs.readDirectory(dir);
        const results: string[] = [];

        for (const [name, type] of entries) {
          if (name.startsWith('.') || name === 'node_modules') continue;

          const itemPath = prefix ? `${prefix}/${name}` : name;
          if (type === vscode.FileType.Directory) {
            results.push(`📁 ${itemPath}/`);
            if (args.recursive) {
              const subDir = vscode.Uri.joinPath(dir, name);
              results.push(...await listDir(subDir, itemPath));
            }
          } else {
            results.push(`📄 ${itemPath}`);
          }
        }
        return results;
      };

      const files = await listDir(dirUri);
      return { success: true, result: files.join('\n') || 'Empty directory' };
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        return { success: false, result: `Directory not found: ${args.path}` };
      }
      throw error;
    }
  }

  private async searchFiles(args: { query: string; path?: string; include?: string; exclude?: string }): Promise<{ success: boolean; result: string }> {
    const searchUri = args.path ? this.resolveUri(args.path) : this.workspaceRootUri;
    if (!searchUri) {
      return { success: false, result: 'No workspace folder open' };
    }

    // Use VS Code's built-in search
    const include = args.include || '**/*';
    const exclude = args.exclude || '**/node_modules/**';

    const pattern = new vscode.RelativePattern(searchUri, include);
    const files = await vscode.workspace.findFiles(pattern, exclude, 100);

    const results: string[] = [];
    const query = args.query.toLowerCase();

    for (const file of files) {
      try {
        const contentBytes = await vscode.workspace.fs.readFile(file);
        const content = new TextDecoder().decode(contentBytes);
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(query)) {
            const relativePath = this.getRelativePath(file);
            results.push(`${relativePath}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      } catch {
        // Skip files that can't be read
      }

      if (results.length >= 50) break;
    }

    return {
      success: true,
      result: results.length > 0 ? results.join('\n') : 'No matches found'
    };
  }

  private async runCommand(args: { command: string; cwd?: string }): Promise<{ success: boolean; result: string }> {
    // Check if we're in a browser environment (no child_process available)
    if (typeof process === 'undefined' || !process.versions?.node) {
      return {
        success: false,
        result: 'Shell commands are not available in web environment. This feature requires the desktop version of VS Code.'
      };
    }

    const cwdUri = args.cwd ? this.resolveUri(args.cwd) : this.workspaceRootUri;
    const cwd = cwdUri?.fsPath || '';

    return new Promise((resolve) => {
      // Dynamic require to avoid bundling issues in browser
      const cp = require('child_process');

      cp.exec(args.command, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 }, (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          resolve({
            success: false,
            result: `Command failed: ${error.message}\n${stderr || ''}`
          });
        } else {
          const output = stdout || stderr || 'Command completed with no output';
          resolve({ success: true, result: output });
        }
      });
    });
  }

  private async openFile(args: { path: string; line?: number }): Promise<{ success: boolean; result: string }> {
    try {
      const fileUri = this.resolveUri(args.path);

      // Check if file exists
      try {
        await vscode.workspace.fs.stat(fileUri);
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
          return { success: false, result: `File not found: ${args.path}` };
        }
        throw error;
      }

      // Open the file in the editor
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });

      // If line number specified, scroll to it
      if (args.line && args.line > 0) {
        const lineIndex = args.line - 1;
        const position = new vscode.Position(lineIndex, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      }

      return { success: true, result: `Opened ${args.path}${args.line ? ` at line ${args.line}` : ''}` };
    } catch (error: any) {
      return { success: false, result: `Error opening file: ${error.message}` };
    }
  }

  // Get current context (open file, selection)
  async getContext(): Promise<{
    openFile?: { path: string; content: string; language: string };
    selection?: { text: string; startLine: number; endLine: number };
    openTabs?: string[];
    workspaceStructure?: string;
  }> {
    const editor = vscode.window.activeTextEditor;
    const context: {
      openFile?: { path: string; content: string; language: string };
      selection?: { text: string; startLine: number; endLine: number };
      openTabs?: string[];
      workspaceStructure?: string;
    } = {};

    if (editor) {
      const doc = editor.document;
      context.openFile = {
        path: this.getRelativePath(doc.uri),
        content: doc.getText(),
        language: doc.languageId
      };

      const selection = editor.selection;
      if (!selection.isEmpty) {
        context.selection = {
          text: doc.getText(selection),
          startLine: selection.start.line + 1,
          endLine: selection.end.line + 1
        };
      }
    }

    // Get list of open files
    const openTabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
    context.openTabs = openTabs
      .filter(tab => tab.input instanceof vscode.TabInputText)
      .map(tab => {
        const input = tab.input as vscode.TabInputText;
        return this.getRelativePath(input.uri);
      })
      .slice(0, 10);

    // Get workspace folder structure (top-level + one level deep)
    context.workspaceStructure = await this.getWorkspaceStructure();

    return context;
  }

  // Get a concise workspace folder structure
  private async getWorkspaceStructure(): Promise<string> {
    if (!this.workspaceRootUri) {
      return '';
    }

    const lines: string[] = [];
    const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'venv', '.venv', 'coverage', '.nyc_output']);
    const ignoreFiles = new Set(['.DS_Store', 'Thumbs.db', '.gitignore', '.env', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

    try {
      const topLevel = await vscode.workspace.fs.readDirectory(this.workspaceRootUri);

      for (const [name, type] of topLevel) {
        if (name.startsWith('.') && name !== '.env.example') continue;
        if (ignoreDirs.has(name)) continue;
        if (ignoreFiles.has(name)) continue;

        if (type === vscode.FileType.Directory) {
          lines.push(`${name}/`);
          // List one level deep for directories
          try {
            const subDir = vscode.Uri.joinPath(this.workspaceRootUri, name);
            const subItems = await vscode.workspace.fs.readDirectory(subDir);
            let count = 0;
            for (const [subName, subType] of subItems) {
              if (count >= 15) break; // Limit to 15 items per dir
              if (subName.startsWith('.')) continue;
              if (ignoreDirs.has(subName)) continue;
              if (ignoreFiles.has(subName)) continue;
              const suffix = subType === vscode.FileType.Directory ? '/' : '';
              lines.push(`  ${subName}${suffix}`);
              count++;
            }
            if (subItems.length > 15) {
              lines.push(`  ... and ${subItems.length - 15} more`);
            }
          } catch {
            // Can't read directory
          }
        } else {
          lines.push(name);
        }
      }
    } catch {
      return '';
    }

    return lines.join('\n');
  }
}

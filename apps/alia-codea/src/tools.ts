import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Tool definitions in OpenAI format
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
      description: 'List files and directories in a given path. Use this to explore the project structure.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The directory path to list, relative to the workspace root. Use "." for root.'
          },
          recursive: {
            type: 'boolean',
            description: 'If true, list files recursively. Default is false.'
          },
          pattern: {
            type: 'string',
            description: 'Optional glob pattern to filter files (e.g., "**/*.ts")'
          }
        },
        required: ['path']
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
  }
];

// Tool execution functions
export class ToolExecutor {
  private workspaceRoot: string;

  constructor() {
    const folders = vscode.workspace.workspaceFolders;
    this.workspaceRoot = folders?.[0]?.uri.fsPath || '';
  }

  private resolvePath(relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      return relativePath;
    }
    return path.join(this.workspaceRoot, relativePath);
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
        default:
          return { success: false, result: `Unknown tool: ${toolName}` };
      }
    } catch (error: any) {
      return { success: false, result: `Error: ${error.message}` };
    }
  }

  private async readFile(args: { path: string; start_line?: number; end_line?: number }): Promise<{ success: boolean; result: string }> {
    const filePath = this.resolvePath(args.path);

    if (!fs.existsSync(filePath)) {
      return { success: false, result: `File not found: ${args.path}` };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
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
  }

  private async writeFile(args: { path: string; content: string }): Promise<{ success: boolean; result: string }> {
    const filePath = this.resolvePath(args.path);

    // Create directory if it doesn't exist
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, args.content, 'utf-8');

    // Open the file in the editor
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc, { preview: false });

    return { success: true, result: `Successfully wrote to ${args.path}` };
  }

  private async editFile(args: { path: string; old_text: string; new_text: string }): Promise<{ success: boolean; result: string }> {
    const filePath = this.resolvePath(args.path);

    if (!fs.existsSync(filePath)) {
      return { success: false, result: `File not found: ${args.path}` };
    }

    const content = fs.readFileSync(filePath, 'utf-8');

    if (!content.includes(args.old_text)) {
      return { success: false, result: `Could not find the specified text in ${args.path}. Make sure the text matches exactly including whitespace.` };
    }

    const newContent = content.replace(args.old_text, args.new_text);
    fs.writeFileSync(filePath, newContent, 'utf-8');

    // Open the file in the editor
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc, { preview: false });

    return { success: true, result: `Successfully edited ${args.path}` };
  }

  private async deleteFile(args: { path: string }): Promise<{ success: boolean; result: string }> {
    const filePath = this.resolvePath(args.path);

    if (!fs.existsSync(filePath)) {
      return { success: false, result: `File not found: ${args.path}` };
    }

    fs.unlinkSync(filePath);
    return { success: true, result: `Successfully deleted ${args.path}` };
  }

  private async listFiles(args: { path: string; recursive?: boolean; pattern?: string }): Promise<{ success: boolean; result: string }> {
    const dirPath = this.resolvePath(args.path);

    if (!fs.existsSync(dirPath)) {
      return { success: false, result: `Directory not found: ${args.path}` };
    }

    if (args.pattern) {
      // Use VS Code's findFiles for glob patterns
      const pattern = new vscode.RelativePattern(dirPath, args.pattern);
      const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 1000);
      const relativePaths = files.map(f => path.relative(this.workspaceRoot, f.fsPath));
      return { success: true, result: relativePaths.join('\n') || 'No files found' };
    }

    const listDir = (dir: string, prefix: string = ''): string[] => {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      const results: string[] = [];

      for (const item of items) {
        if (item.name.startsWith('.') || item.name === 'node_modules') continue;

        const itemPath = path.join(prefix, item.name);
        if (item.isDirectory()) {
          results.push(`📁 ${itemPath}/`);
          if (args.recursive) {
            results.push(...listDir(path.join(dir, item.name), itemPath));
          }
        } else {
          results.push(`📄 ${itemPath}`);
        }
      }
      return results;
    };

    const files = listDir(dirPath);
    return { success: true, result: files.join('\n') || 'Empty directory' };
  }

  private async searchFiles(args: { query: string; path?: string; include?: string; exclude?: string }): Promise<{ success: boolean; result: string }> {
    const searchPath = args.path ? this.resolvePath(args.path) : this.workspaceRoot;

    // Use VS Code's built-in search
    const include = args.include || '**/*';
    const exclude = args.exclude || '**/node_modules/**';

    const pattern = new vscode.RelativePattern(searchPath, include);
    const files = await vscode.workspace.findFiles(pattern, exclude, 100);

    const results: string[] = [];
    const query = args.query.toLowerCase();

    for (const file of files) {
      try {
        const content = fs.readFileSync(file.fsPath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(query)) {
            const relativePath = path.relative(this.workspaceRoot, file.fsPath);
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
    const cwd = args.cwd ? this.resolvePath(args.cwd) : this.workspaceRoot;

    return new Promise((resolve) => {
      const { exec } = require('child_process');

      exec(args.command, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 }, (error: any, stdout: string, stderr: string) => {
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

  // Get current context (open file, selection)
  async getContext(): Promise<{
    openFile?: { path: string; content: string; language: string };
    selection?: { text: string; startLine: number; endLine: number };
    openTabs?: string[];
  }> {
    const editor = vscode.window.activeTextEditor;
    const context: any = {};

    if (editor) {
      const doc = editor.document;
      context.openFile = {
        path: path.relative(this.workspaceRoot, doc.uri.fsPath),
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
        return path.relative(this.workspaceRoot, input.uri.fsPath);
      })
      .slice(0, 10);

    return context;
  }
}

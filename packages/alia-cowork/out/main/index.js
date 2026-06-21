"use strict";
const electron = require("electron");
const path = require("path");
const child_process = require("child_process");
const fs = require("fs");
const os = require("os");
const util = require("util");
const https = require("https");
const http = require("http");
const Store = require("electron-store");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
const os__namespace = /* @__PURE__ */ _interopNamespaceDefault(os);
const https__namespace = /* @__PURE__ */ _interopNamespaceDefault(https);
const http__namespace = /* @__PURE__ */ _interopNamespaceDefault(http);
const execAsync = util.promisify(child_process.exec);
const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file from the filesystem.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path to the file" },
          start_line: { type: "number", description: "Optional starting line (1-indexed)" },
          end_line: { type: "number", description: "Optional ending line (1-indexed)" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file with content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file" },
          content: { type: "string", description: "Content to write" }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace specific text in a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file" },
          old_text: { type: "string", description: "Text to find and replace" },
          new_text: { type: "string", description: "Replacement text" }
        },
        required: ["path", "old_text", "new_text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories in a path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path" },
          recursive: { type: "boolean", description: "List recursively" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search for text patterns in files.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search pattern" },
          path: { type: "string", description: "Directory to search in" },
          include: { type: "string", description: "File pattern to include (e.g., *.ts)" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a shell command.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          cwd: { type: "string", description: "Working directory" }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "open_application",
      description: "Open an application or file with the default program.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Application name or file path to open" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "open_url",
      description: "Open a URL in the default browser.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to open" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "clipboard_read",
      description: "Read the current clipboard content.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "clipboard_write",
      description: "Write text to the clipboard.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to copy to clipboard" }
        },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_system_info",
      description: "Get system information (OS, CPU, memory, etc.).",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "screenshot",
      description: "Take a screenshot of the screen.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "set_mode",
      description: "Change the assistant operating mode.",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["ask", "edit", "plan", "yolo"],
            description: "The mode to switch to"
          }
        },
        required: ["mode"]
      }
    }
  }
];
class ToolExecutor {
  constructor() {
    this.homeDir = os__namespace.homedir();
  }
  resolvePath(filePath) {
    if (path__namespace.isAbsolute(filePath)) {
      return filePath;
    }
    if (filePath.startsWith("~")) {
      return path__namespace.join(this.homeDir, filePath.slice(1));
    }
    return path__namespace.resolve(filePath);
  }
  async execute(toolName, args) {
    try {
      switch (toolName) {
        case "read_file":
          return await this.readFile(args);
        case "write_file":
          return await this.writeFile(args);
        case "edit_file":
          return await this.editFile(args);
        case "list_files":
          return await this.listFiles(args);
        case "search_files":
          return await this.searchFiles(args);
        case "run_command":
          return await this.runCommand(args);
        case "open_application":
          return await this.openApplication(args);
        case "open_url":
          return await this.openUrl(args);
        case "clipboard_read":
          return this.clipboardRead();
        case "clipboard_write":
          return this.clipboardWrite(args);
        case "get_system_info":
          return this.getSystemInfo();
        case "screenshot":
          return await this.screenshot();
        default:
          return { success: false, result: `Unknown tool: ${toolName}` };
      }
    } catch (error) {
      return { success: false, result: `Error: ${error.message}` };
    }
  }
  async readFile(args) {
    const filePath = this.resolvePath(args.path);
    if (!fs__namespace.existsSync(filePath)) {
      return { success: false, result: `File not found: ${args.path}` };
    }
    const content = fs__namespace.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    if (args.start_line || args.end_line) {
      const start = (args.start_line || 1) - 1;
      const end = args.end_line || lines.length;
      const selectedLines = lines.slice(start, end);
      return {
        success: true,
        result: selectedLines.map((line, i) => `${start + i + 1}: ${line}`).join("\n")
      };
    }
    const numberedContent = lines.map((line, i) => `${i + 1}: ${line}`).join("\n");
    return { success: true, result: numberedContent };
  }
  async writeFile(args) {
    const filePath = this.resolvePath(args.path);
    const dir = path__namespace.dirname(filePath);
    if (!fs__namespace.existsSync(dir)) {
      fs__namespace.mkdirSync(dir, { recursive: true });
    }
    fs__namespace.writeFileSync(filePath, args.content, "utf-8");
    return { success: true, result: `Successfully wrote to ${args.path}` };
  }
  async editFile(args) {
    const filePath = this.resolvePath(args.path);
    if (!fs__namespace.existsSync(filePath)) {
      return { success: false, result: `File not found: ${args.path}` };
    }
    const content = fs__namespace.readFileSync(filePath, "utf-8");
    if (!content.includes(args.old_text)) {
      return { success: false, result: `Could not find the specified text in ${args.path}` };
    }
    const newContent = content.replace(args.old_text, args.new_text);
    fs__namespace.writeFileSync(filePath, newContent, "utf-8");
    return { success: true, result: `Successfully edited ${args.path}` };
  }
  async listFiles(args) {
    const dirPath = this.resolvePath(args.path);
    if (!fs__namespace.existsSync(dirPath)) {
      return { success: false, result: `Directory not found: ${args.path}` };
    }
    const listDir = (dir, prefix = "") => {
      const items = [];
      const entries = fs__namespace.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = path__namespace.join(dir, entry.name);
        const displayPath = prefix + entry.name;
        if (entry.isDirectory()) {
          items.push(`${displayPath}/`);
          if (args.recursive) {
            items.push(...listDir(fullPath, `${displayPath}/`));
          }
        } else {
          items.push(displayPath);
        }
      }
      return items;
    };
    const files = listDir(dirPath);
    return { success: true, result: files.join("\n") };
  }
  async searchFiles(args) {
    const searchPath = this.resolvePath(args.path || ".");
    const platform = process.platform;
    let command;
    if (platform === "win32") {
      command = `findstr /s /n /i "${args.query}" ${args.include || "*.*"}`;
    } else {
      const includeArg = args.include ? `--include="${args.include}"` : "";
      command = `grep -rn ${includeArg} "${args.query}" .`;
    }
    try {
      const { stdout } = await execAsync(command, { cwd: searchPath, maxBuffer: 1024 * 1024 });
      return { success: true, result: stdout.slice(0, 5e3) };
    } catch (error) {
      if (error.code === 1) {
        return { success: true, result: "No matches found" };
      }
      return { success: false, result: error.message };
    }
  }
  async runCommand(args) {
    const cwd = args.cwd ? this.resolvePath(args.cwd) : this.homeDir;
    try {
      const { stdout, stderr } = await execAsync(args.command, {
        cwd,
        maxBuffer: 1024 * 1024,
        timeout: 6e4
      });
      const output = stdout + (stderr ? `
${stderr}` : "");
      return { success: true, result: output.slice(0, 1e4) };
    } catch (error) {
      return { success: false, result: error.message };
    }
  }
  async openApplication(args) {
    try {
      await electron.shell.openPath(args.path);
      return { success: true, result: `Opened ${args.path}` };
    } catch (error) {
      return { success: false, result: error.message };
    }
  }
  async openUrl(args) {
    try {
      await electron.shell.openExternal(args.url);
      return { success: true, result: `Opened ${args.url}` };
    } catch (error) {
      return { success: false, result: error.message };
    }
  }
  clipboardRead() {
    const text = electron.clipboard.readText();
    return { success: true, result: text || "(clipboard is empty)" };
  }
  clipboardWrite(args) {
    electron.clipboard.writeText(args.text);
    return { success: true, result: "Copied to clipboard" };
  }
  getSystemInfo() {
    const info = {
      platform: os__namespace.platform(),
      arch: os__namespace.arch(),
      hostname: os__namespace.hostname(),
      cpus: os__namespace.cpus().length,
      totalMemory: `${Math.round(os__namespace.totalmem() / 1024 / 1024 / 1024)}GB`,
      freeMemory: `${Math.round(os__namespace.freemem() / 1024 / 1024 / 1024)}GB`,
      homeDir: os__namespace.homedir(),
      tempDir: os__namespace.tmpdir(),
      uptime: `${Math.round(os__namespace.uptime() / 3600)} hours`
    };
    return { success: true, result: JSON.stringify(info, null, 2) };
  }
  async screenshot() {
    try {
      const sources = await electron.desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1920, height: 1080 }
      });
      if (sources.length > 0) {
        const dataUrl = sources[0].thumbnail.toDataURL();
        return { success: true, result: dataUrl };
      }
      return { success: false, result: "No screen found" };
    } catch (error) {
      return { success: false, result: error.message };
    }
  }
}
const store = new Store({
  defaults: {
    apiKey: "",
    apiBaseUrl: "https://api.alia.onl",
    model: "alia-v1-codea"
  }
});
class ChatProvider {
  constructor(window, toolExecutor2) {
    this.messages = [];
    this.isProcessing = false;
    this.currentMode = "ask";
    this.window = window;
    this.toolExecutor = toolExecutor2;
  }
  send(channel, data) {
    this.window.webContents.send(channel, data);
  }
  async handleMessage(content, mode = "ask", model, context) {
    if (this.isProcessing) return;
    const apiKey = store.get("apiKey");
    const baseUrl = store.get("apiBaseUrl");
    const selectedModel = model || store.get("model");
    if (!apiKey) {
      this.send("chat:error", { message: "Please set your API key in settings" });
      return;
    }
    this.currentMode = mode;
    this.isProcessing = true;
    let enhancedContent = content;
    if (context && context.length > 0) {
      for (const item of context) {
        enhancedContent += `

**File: ${item.path}**
\`\`\`${item.language || ""}
${item.content}
\`\`\``;
      }
    }
    this.messages.push({ role: "user", content: enhancedContent });
    const systemMessage = this.buildSystemMessage();
    this.send("chat:start", {});
    await this.processConversation(baseUrl, apiKey, selectedModel, systemMessage);
    this.isProcessing = false;
  }
  buildSystemMessage() {
    let systemMessage = `You are Alia Cowork, an AI assistant that can control and automate tasks on the user's computer. Be concise and action-oriented.

## Critical Rules
1. **NEVER ask follow-up questions** - Just execute the task directly.
2. **NEVER show diffs or ask for approval** - Execute changes directly with tools.
3. **Use tools proactively** - You have full access to the filesystem and can run commands.

## Available Tools
- **read_file**: Read file contents
- **write_file**: Create/overwrite files
- **edit_file**: Replace text in files
- **list_files**: List directory contents
- **search_files**: Search for patterns
- **run_command**: Execute shell commands
- **open_application**: Open apps or files
- **open_url**: Open URLs in browser
- **clipboard_read/write**: Access clipboard
- **get_system_info**: Get system details
- **screenshot**: Capture screen
- **set_mode**: Change operating mode

## Platform
You are running on ${process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux"}.

## Response Style
- Be brief and direct
- Execute tasks immediately
- Confirm completion with a short summary`;
    if (this.currentMode === "ask") {
      systemMessage += `

## Mode: ASK
Confirm destructive operations only.`;
    } else if (this.currentMode === "edit") {
      systemMessage += `

## Mode: EDIT
Make changes directly without confirmation.`;
    } else if (this.currentMode === "yolo") {
      systemMessage += `

## Mode: YOLO
Full autonomous mode. Execute everything.`;
    }
    return systemMessage;
  }
  async processConversation(baseUrl, apiKey, model, systemMessage) {
    while (this.isProcessing) {
      try {
        const result = await this.streamChatCompletion(baseUrl, apiKey, model, systemMessage);
        if (!this.isProcessing) break;
        if (result.toolCalls && result.toolCalls.length > 0) {
          this.messages.push({
            role: "assistant",
            content: result.content,
            tool_calls: result.toolCalls
          });
          for (const toolCall of result.toolCalls) {
            if (!this.isProcessing) break;
            const args = JSON.parse(toolCall.function.arguments);
            this.send("chat:tool", {
              tool: toolCall.function.name,
              args,
              status: "running"
            });
            let toolResult;
            if (toolCall.function.name === "set_mode") {
              const newMode = args.mode;
              if (["ask", "edit", "plan", "yolo"].includes(newMode)) {
                this.currentMode = newMode;
                this.send("chat:modeChanged", { mode: newMode });
                toolResult = { success: true, result: `Mode changed to ${newMode}` };
              } else {
                toolResult = { success: false, result: `Invalid mode: ${newMode}` };
              }
            } else {
              toolResult = await this.toolExecutor.execute(toolCall.function.name, args);
            }
            this.send("chat:toolResult", {
              tool: toolCall.function.name,
              success: toolResult.success,
              result: toolResult.result.slice(0, 500)
            });
            this.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: toolResult.result
            });
          }
          continue;
        } else {
          this.messages.push({ role: "assistant", content: result.content });
          this.send("chat:end", {});
          break;
        }
      } catch (error) {
        let errorMessage = error.message || "An error occurred";
        if (errorMessage.includes("HTTP 402")) {
          errorMessage = "Insufficient credits. Please add more credits at alia.onl";
        } else if (errorMessage.includes("HTTP 401")) {
          errorMessage = "Invalid API key. Please check your settings.";
        }
        this.send("chat:error", { message: errorMessage });
        break;
      }
    }
  }
  streamChatCompletion(baseUrl, apiKey, model, systemMessage) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${baseUrl}/v1/chat/completions`);
      const isHttps = url.protocol === "https:";
      const httpModule = isHttps ? https__namespace : http__namespace;
      const messagesWithSystem = [
        { role: "system", content: systemMessage },
        ...this.messages
      ];
      const requestBody = JSON.stringify({
        model,
        messages: messagesWithSystem.map((m) => {
          if (m.tool_calls) {
            return { role: m.role, content: m.content || "", tool_calls: m.tool_calls };
          } else if (m.tool_call_id) {
            return { role: m.role, tool_call_id: m.tool_call_id, name: m.name, content: m.content };
          }
          return { role: m.role, content: m.content };
        }),
        stream: true,
        tools: toolDefinitions,
        tool_choice: "auto"
      });
      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(requestBody)
        }
      };
      let fullContent = "";
      const toolCalls = [];
      let currentToolCall = null;
      const req = httpModule.request(options, (res) => {
        if (res.statusCode !== 200) {
          let errorBody = "";
          res.on("data", (chunk) => errorBody += chunk);
          res.on("end", () => {
            try {
              const error = JSON.parse(errorBody);
              reject(new Error(`HTTP ${res.statusCode}: ${error.error?.message || ""}`));
            } catch {
              reject(new Error(`HTTP ${res.statusCode}: ${errorBody}`));
            }
          });
          return;
        }
        let buffer = "";
        res.on("data", (chunk) => {
          if (!this.isProcessing) return;
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6).trim();
              if (data === "[DONE]") continue;
              try {
                const parsed = JSON.parse(data);
                const choice = parsed.choices?.[0];
                if (choice?.delta?.content) {
                  fullContent += choice.delta.content;
                  this.send("chat:stream", { content: choice.delta.content });
                }
                if (choice?.delta?.tool_calls) {
                  for (const tc of choice.delta.tool_calls) {
                    if (tc.id) {
                      currentToolCall = {
                        id: tc.id,
                        type: "function",
                        function: {
                          name: tc.function?.name || "",
                          arguments: tc.function?.arguments || ""
                        }
                      };
                      toolCalls.push(currentToolCall);
                      if (currentToolCall.function.name) {
                        this.send("chat:tool", {
                          tool: currentToolCall.function.name,
                          args: {},
                          status: "preparing"
                        });
                      }
                    } else if (currentToolCall) {
                      if (tc.function?.name) {
                        currentToolCall.function.name = tc.function.name;
                        this.send("chat:tool", {
                          tool: currentToolCall.function.name,
                          args: {},
                          status: "preparing"
                        });
                      }
                      if (tc.function?.arguments) {
                        currentToolCall.function.arguments += tc.function.arguments;
                      }
                    }
                  }
                }
              } catch {
              }
            }
          }
        });
        res.on("end", () => {
          this.currentRequest = void 0;
          resolve({ content: fullContent, toolCalls: toolCalls.length > 0 ? toolCalls : void 0 });
        });
      });
      req.on("error", (error) => {
        this.currentRequest = void 0;
        reject(error);
      });
      this.currentRequest = {
        abort: () => req.destroy()
      };
      req.write(requestBody);
      req.end();
    });
  }
  stop() {
    this.isProcessing = false;
    if (this.currentRequest) {
      this.currentRequest.abort();
      this.currentRequest = void 0;
    }
    this.send("chat:end", {});
  }
  clear() {
    this.messages = [];
    this.send("chat:cleared", {});
  }
  async getUserInfo() {
    const apiKey = store.get("apiKey");
    const baseUrl = store.get("apiBaseUrl");
    if (!apiKey) return null;
    return new Promise((resolve) => {
      const url = new URL(`${baseUrl}/v1/codea/me`);
      const isHttps = url.protocol === "https:";
      const httpModule = isHttps ? https__namespace : http__namespace;
      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` }
        },
        (res) => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          let data = "";
          res.on("data", (chunk) => data += chunk);
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(null);
            }
          });
        }
      );
      req.on("error", () => resolve(null));
      req.end();
    });
  }
  async getModels() {
    const baseUrl = store.get("apiBaseUrl");
    return new Promise((resolve) => {
      const url = new URL(`${baseUrl}/v1/models?category=coding`);
      const isHttps = url.protocol === "https:";
      const httpModule = isHttps ? https__namespace : http__namespace;
      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: "GET"
        },
        (res) => {
          if (res.statusCode !== 200) {
            resolve([]);
            return;
          }
          let data = "";
          res.on("data", (chunk) => data += chunk);
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed.data || []);
            } catch {
              resolve([]);
            }
          });
        }
      );
      req.on("error", () => resolve([]));
      req.end();
    });
  }
}
let mainWindow = null;
let toolExecutor;
let chatProvider;
function createWindow() {
  const { width, height } = electron.screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new electron.BrowserWindow({
    width: 420,
    height: 700,
    minWidth: 380,
    minHeight: 500,
    x: width - 440,
    y: 20,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: "hiddenInset",
    vibrancy: "under-window",
    visualEffectState: "active",
    backgroundColor: "#00000000"
  });
  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    electron.shell.openExternal(details.url);
    return { action: "deny" };
  });
  if (!electron.app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  toolExecutor = new ToolExecutor();
  chatProvider = new ChatProvider(mainWindow, toolExecutor);
}
function setupIPC() {
  electron.ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  electron.ipcMain.handle("window:maximize", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  electron.ipcMain.handle("window:close", () => mainWindow?.close());
  electron.ipcMain.handle("window:toggle-always-on-top", () => {
    const isOnTop = mainWindow?.isAlwaysOnTop();
    mainWindow?.setAlwaysOnTop(!isOnTop);
    return !isOnTop;
  });
  electron.ipcMain.handle("chat:send", async (_, message, mode, model, context) => {
    return chatProvider.handleMessage(message, mode, model, context);
  });
  electron.ipcMain.handle("chat:stop", () => chatProvider.stop());
  electron.ipcMain.handle("chat:clear", () => chatProvider.clear());
  electron.ipcMain.handle("user:get", () => chatProvider.getUserInfo());
  electron.ipcMain.handle("models:get", () => chatProvider.getModels());
  electron.ipcMain.handle("screen:capture", async () => {
    const sources = await electron.desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1920, height: 1080 }
    });
    if (sources.length > 0) {
      return sources[0].thumbnail.toDataURL();
    }
    return null;
  });
  electron.ipcMain.handle("tool:execute", async (_, toolName, args) => {
    return toolExecutor.execute(toolName, args);
  });
}
electron.app.whenReady().then(() => {
  if (process.platform === "win32") {
    electron.app.setAppUserModelId("com.alia.cowork");
  }
  setupIPC();
  createWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});

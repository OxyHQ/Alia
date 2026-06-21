export interface AgentTool {
  id: string;
  name: string;
  icon: string;
  description: string;
}

export const AGENT_TOOLS: AgentTool[] = [
  { id: "web-browsing", name: "Web Browsing", icon: "Globe", description: "Browse websites and extract content" },
  { id: "code-execution", name: "Code Execution", icon: "Terminal", description: "Run code in sandboxed containers" },
  { id: "google-search", name: "Google Search", icon: "Search", description: "Search the web for information" },
  { id: "web-scraping", name: "Web Scraping", icon: "FileDown", description: "Extract data from web pages" },
  { id: "file-management", name: "File Management", icon: "FolderOpen", description: "Read, write, and manage files" },
  { id: "image-generation", name: "Image Generation", icon: "Image", description: "Generate images from text" },
  { id: "memory", name: "Memory", icon: "Brain", description: "Remember info across conversations" },
  { id: "agent-delegation", name: "Agent Delegation", icon: "Users", description: "Delegate subtasks to other agents" },
];

export const AGENT_TOOL_IDS = AGENT_TOOLS.map((t) => t.id);

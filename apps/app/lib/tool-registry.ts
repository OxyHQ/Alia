import {
  Search,
  Link,
  Calendar,
  Database,
  Globe,
  MessageCircle,
  Send,
  Brain,
  FileText,
  Settings,
  User,
} from "lucide-react-native";

export interface ToolDefinition {
  icon: any;
  label: string;
  category: "search" | "communication" | "utility" | "memory";
}

const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  // Search
  webSearch:           { icon: Search,        label: "Searching the web",         category: "search" },
  scrapeURL:           { icon: Link,          label: "Reading URL",               category: "search" },
  getTimeline:         { icon: Calendar,      label: "Getting timeline",          category: "search" },
  searchKnowledgeBase: { icon: Database,      label: "Searching knowledge base",  category: "search" },
  webScraper:          { icon: Globe,         label: "Reading web page",          category: "search" },
  browse:              { icon: Globe,         label: "Browsing the web",          category: "search" },

  // Communication
  sendWhatsAppMessage: { icon: MessageCircle, label: "Sending WhatsApp message",  category: "communication" },
  getWhatsAppChats:    { icon: MessageCircle, label: "Loading WhatsApp chats",    category: "communication" },
  getWhatsAppMessages: { icon: MessageCircle, label: "Reading WhatsApp messages", category: "communication" },
  sendTelegram:        { icon: Send,          label: "Sending Telegram message",  category: "communication" },

  // Utility
  getCurrentDate:      { icon: Calendar,      label: "Getting current date",      category: "utility" },
  generateFile:        { icon: FileText,      label: "Generating file",           category: "utility" },

  // Memory
  saveUserMemory:        { icon: Brain,    label: "Saving to memory",      category: "memory" },
  updateUserPreferences: { icon: Settings, label: "Updating preferences",  category: "memory" },
  updateUserContext:     { icon: User,     label: "Updating context",      category: "memory" },
};

export function getToolIcon(toolName: string) {
  return TOOL_REGISTRY[toolName]?.icon || Globe;
}

export function getToolLabel(toolName: string) {
  return TOOL_REGISTRY[toolName]?.label || toolName;
}

export { TOOL_REGISTRY };

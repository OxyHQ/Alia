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


const TOOL_ICON_REGISTRY: Record<string, any> = {
  webSearch: Search,
  scrapeURL: Link,
  getTimeline: Calendar,
  searchKnowledgeBase: Database,
  webScraper: Globe,
  browse: Globe,
  sendWhatsAppMessage: MessageCircle,
  getWhatsAppChats: MessageCircle,
  getWhatsAppMessages: MessageCircle,
  sendTelegram: Send,
  getCurrentDate: Calendar,
  generateFile: FileText,
  saveUserMemory: Brain,
  updateUserPreferences: Settings,
  updateUserContext: User,
};

export function getToolIcon(toolName: string) {
  return TOOL_ICON_REGISTRY[toolName] || Globe;
}

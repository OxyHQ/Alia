// ============== TIPOS COMPARTIDOS ==============

export interface KeyLimits {
  rpm?: number;    // Requests per minute
  rpd?: number;    // Requests per day
  tpm?: number;    // Tokens per minute
  tpd?: number;    // Tokens per day
}

export interface KeyConfig {
  provider: string;
  modelId: string;
  key: string;
  isPaid?: boolean;
  // Límites (todos opcionales)
  rpm?: number;
  rpd?: number;
  tpm?: number;
  tpd?: number;
}

export interface ProviderConfig {
  temperature?: number;
  maxTokens?: number;
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: any;
  };
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | any[];
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export interface Provider {
  name: string;
  isEnabled: () => boolean;
  proxy: (
    key: KeyConfig,
    messages: OpenAIMessage[],
    tools?: OpenAITool[],
    config?: ProviderConfig
  ) => Promise<ReadableStream>;
}

// ============== FOLDERS & CHAT HISTORY ==============

export type FolderColor = "gray" | "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink";

export const FOLDER_COLORS: { value: FolderColor; label: string }[] = [
  { value: "gray", label: "Gris" },
  { value: "red", label: "Rojo" },
  { value: "orange", label: "Naranja" },
  { value: "yellow", label: "Amarillo" },
  { value: "green", label: "Verde" },
  { value: "blue", label: "Azul" },
  { value: "purple", label: "Morado" },
  { value: "pink", label: "Rosa" },
];

export interface ChatFolder {
  id: string;
  name: string;
  color: FolderColor;
  icon?: string;
  parentId?: string | null;
  isOpen?: boolean; // UI state
}

export interface ChatHistory {
  id: string;
  title: string;
  updatedAt: string;
  folderId?: string | null;
  icon?: string;
  iconColor?: string;
  isFavorite?: boolean;
  isPublic?: boolean;
  messages?: any[]; // Only if needed locally
}

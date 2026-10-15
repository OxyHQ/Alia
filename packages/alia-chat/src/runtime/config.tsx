import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { ALIA_API_URL } from '../lib/api-url';
import type { Message } from './types';

/**
 * Where a signed-out session keeps its conversations, per account. The host
 * binds it to the signed-in account; unbound it reads nothing and writes
 * nothing. `AccountScopedKey` in the Alia app is one.
 */
export interface OfflineConversationStore {
  getItem(): Promise<string | null>;
  setItem(value: string): Promise<void>;
}

/** An artifact a tool produced (a generated file, a canvas), for the host to show beside the thread. */
export interface AliaArtifact {
  id: string;
  type: string;
  content: unknown;
  title: string;
  timestamp: number;
}

/** The usage frame a stream ends with: the balance left and, sometimes, a spending warning. */
export interface AliaUsageFrame {
  credits_remaining?: number;
  credit_warning?: {
    level?: string;
    daysRemaining?: unknown;
    todaySpend?: unknown;
    avgDailySpend?: unknown;
    currentModelMultiplier?: unknown;
  };
  [key: string]: unknown;
}

/** What the request carries that the host's own controls decide, read at send time. */
export interface AliaTurnRequest {
  /** Only `false` is sent: `true` is the server's default. */
  webSearch?: boolean;
  agentMode?: boolean;
  deepResearch?: boolean;
}

/**
 * Everything the conversation runtime needs from the app around it, as typed
 * callbacks. Every member is optional: a host that omits one gets the plain
 * behaviour (no navigation, no artifacts panel, no credits). The Alia app and
 * the sheet mount the SAME runtime and differ only in what they put here.
 */
export interface AliaRuntimeHost {
  /** Device facts sent as `X-Device-Info`, so the model's `getDeviceInfo` tool can answer. */
  deviceInfo?: () => Promise<unknown>;
  /** The modes the host's composer controls own; read when the turn is sent, not when it is built. */
  turnRequest?: () => AliaTurnRequest;
  /** A turn is about to be sent from the composer or a retry. */
  onTurnStart?: () => void;
  /** Real answer text just arrived (throttled): a haptic tick. */
  onOutput?: () => void;
  /** The stream's usage frame: credits left and the spending warning. */
  onUsage?: (usage: AliaUsageFrame) => void;
  /** A tool finished; `name` is the tool, `output` its structural result. */
  onToolResult?: (result: {
    toolCallId: string;
    name: string | undefined;
    output: unknown;
  }) => void;
  /** A tool produced something worth its own panel. */
  onArtifact?: (artifact: AliaArtifact) => void;
  /** What this turn put in the context window (`alia.context`), raw. */
  onContext?: (conversationId: string | null, payload: unknown) => void;
  /** A delegated agent started a run of its own for this turn. */
  onAgentTurn?: (turn: { turnId: string; agentId: string; conversationId: string | null }) => void;
  /** The agent's row in the host's list, ahead of the server: your line, then her answer. */
  onTurnPreview?: (agentId: string | null | undefined, text: string) => void;
  /**
   * Messages an agent writes into the open conversation by itself (a result, a check-in).
   * Returns the unsubscribe.
   */
  subscribeConversationMessages?: (
    conversationId: string,
    listener: (message: Message) => void,
  ) => () => void;
  /** The runtime created or chose a conversation: show it. Omitted, the host shows nothing new. */
  openConversation?: (conversationId: string) => void;
  /** The open conversation is gone (deleted elsewhere, or a first send failed): leave it. */
  closeConversation?: () => void;
}

export interface AliaRuntimeConfig {
  /** Alia's API origin; the conversation routes (`/conversations`) hang off it. */
  apiUrl: string;
  /** The turn route, absolute. Omitted, `${apiUrl}/alia/chat`. */
  chatUrl: string;
  /** The offline copy of the conversations, when the host keeps one. */
  offline: OfflineConversationStore | null;
  /**
   * The `fetch` a turn is streamed with. React Native's own cannot stream a
   * body; Expo's (`expo/fetch`) can. Omitted, the platform's.
   */
  streamFetch: typeof fetch | undefined;
  host: AliaRuntimeHost;
}

export interface AliaRuntimeProviderProps extends Partial<Omit<AliaRuntimeConfig, 'host'>> {
  host?: AliaRuntimeHost;
  children: ReactNode;
}

const DEFAULT_CONFIG: AliaRuntimeConfig = {
  apiUrl: ALIA_API_URL,
  chatUrl: `${ALIA_API_URL}/alia/chat`,
  offline: null,
  streamFetch: undefined,
  host: {},
};

const AliaRuntimeContext = createContext<AliaRuntimeConfig>(DEFAULT_CONFIG);

/**
 * Configure the conversation runtime for everything below. Providers nest and
 * merge: what a nearer one leaves out, the outer one (or the default) answers.
 * The sheet and the screen mount one from their own props; the Alia app mounts
 * one above its routes, so its sidebar and its conversation read the same
 * conversations through the same hooks.
 */
export function AliaRuntimeProvider({
  apiUrl,
  chatUrl,
  offline,
  streamFetch,
  host,
  children,
}: AliaRuntimeProviderProps) {
  const parent = useContext(AliaRuntimeContext);
  const value = useMemo<AliaRuntimeConfig>(() => {
    const nextApiUrl = apiUrl ?? parent.apiUrl;
    return {
      apiUrl: nextApiUrl,
      // A host that changes only `apiUrl` moves the turn route with it.
      chatUrl: chatUrl ?? (apiUrl === undefined ? parent.chatUrl : `${nextApiUrl}/alia/chat`),
      offline: offline === undefined ? parent.offline : offline,
      streamFetch: streamFetch ?? parent.streamFetch,
      host: host === undefined ? parent.host : { ...parent.host, ...host },
    };
  }, [apiUrl, chatUrl, offline, streamFetch, host, parent]);
  return <AliaRuntimeContext.Provider value={value}>{children}</AliaRuntimeContext.Provider>;
}

/** The runtime's configuration: the nearest provider's, or the defaults. */
export function useAliaRuntime(): AliaRuntimeConfig {
  return useContext(AliaRuntimeContext);
}

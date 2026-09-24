import {
  consumeAliaChatStream,
  type AliaChatStreamEvent,
  type AliaChatStreamResult,
} from './chat-stream';

export interface AuthenticatedResponseClient {
  requestAuthenticatedResponse(config: {
    method: 'POST';
    url: string;
    body: string;
    headers: Record<string, string>;
    signal: AbortSignal;
  }): Promise<Response>;
}

export interface AliaChatRequest {
  readonly url: string;
  readonly model: string;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  /**
   * `'voice'` asks for an answer meant to be heard: short, conversational, no
   * formatting (the API layers its voice response profile over the turn's
   * prompt). Omitted for ordinary text chat, which sends exactly what it
   * always sent.
   */
  readonly responseMode?: 'voice';
  /** The agent whose thread this turn belongs to, when there is one. */
  readonly agentId?: string;
}

/**
 * The authenticated transport boundary for an SDK chat turn. Authentication,
 * preflight refresh and the single supported 401 replay belong to the linked
 * Oxy client; this layer never reads or writes bearer tokens itself.
 */
export async function streamAliaChat(
  client: AuthenticatedResponseClient,
  request: AliaChatRequest,
  signal: AbortSignal,
  onEvent: (event: AliaChatStreamEvent) => void,
): Promise<AliaChatStreamResult> {
  const response = await client.requestAuthenticatedResponse({
    method: 'POST',
    url: request.url,
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      stream: true,
      ...(request.responseMode === undefined ? {} : { responseMode: request.responseMode }),
      ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
    }),
    signal,
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Alia request failed with status ${response.status}.`);
  }

  return consumeAliaChatStream(response, onEvent, signal);
}

import {
  AliaChatStreamError,
  consumeAliaChatStream,
  readAliaChatFailure,
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
  /** `publisher/model`; omitted, the server's default model answers. */
  readonly model?: string;
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
      ...(request.model === undefined ? {} : { model: request.model }),
      messages: request.messages,
      stream: true,
      ...(request.responseMode === undefined ? {} : { responseMode: request.responseMode }),
      ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
    }),
    signal,
  });

  if (!response.ok) {
    throw new AliaChatStreamError(`Alia request failed with status ${response.status}.`, {
      ...(await readErrorEnvelope(response)),
      status: response.status,
    });
  }

  return consumeAliaChatStream(response, onEvent, signal);
}

/** Bodies larger than this are not an Alia error envelope and are not read. */
const MAX_ERROR_BODY_BYTES = 16 * 1024;

/**
 * The code, retryability and reference of an HTTP refusal or failed turn.
 *
 * Without them a caller cannot tell "send it again" (a 503 for a turn that
 * failed before any output) from "this will not work" (a 400), so the status
 * is not enough. A body that is large, not JSON or not the envelope yields
 * nothing, and the status alone still reaches the caller.
 */
async function readErrorEnvelope(response: Response) {
  const length = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > MAX_ERROR_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return {};
  }
  try {
    const text = await response.text();
    if (text.length > MAX_ERROR_BODY_BYTES) return {};
    return readAliaChatFailure(JSON.parse(text));
  } catch {
    return {};
  }
}

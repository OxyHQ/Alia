/**
 * How a voice call gets its answers: through the ordinary chat path.
 *
 * A spoken turn is a chat turn. There is no voice session endpoint and no
 * realtime model behind this — the person's words, recognized on the device,
 * go to Alia's chat handler exactly as typed words do (conversation, memory,
 * agents, tools and all), and the answer comes back as the same SSE stream.
 * The only thing that marks it as spoken is `responseMode: 'voice'`, which asks
 * for an answer meant to be heard.
 *
 * A consumer that already owns a chat — the Alia app, whose conversation screen
 * persists every turn and shows it in the thread — passes its own sender, so
 * the call's turns ARE that conversation's turns. `createAliaVoiceTurnSender`
 * is the default for everyone else: the same request `useAliaChat` makes.
 */

import { streamAliaChat, type AuthenticatedResponseClient } from './chat-transport';
import { resolveModelId } from './catalogue';

export interface VoiceTurnMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface VoiceTurn {
  /** What the person said, as recognized. */
  readonly text: string;
  /** Earlier turns of this call, oldest first, not including `text`. */
  readonly history: readonly VoiceTurnMessage[];
  /** Aborted when the person interrupts or the call ends. */
  readonly signal: AbortSignal;
  /** Report the answer as it streams — the WHOLE answer so far, each time. */
  readonly onText: (answerSoFar: string) => void;
}

/**
 * Send one spoken turn and stream its answer through `onText`.
 *
 * Resolves when the answer is complete; rejects when the turn could not be
 * sent at all. An answer that is empty is not a rejection — the voice loop
 * reports it and keeps listening.
 */
export type VoiceTurnSender = (turn: VoiceTurn) => Promise<void>;

interface LinkedClientFactory {
  createLinkedClient(config: { baseURL: string }): { client: AuthenticatedResponseClient; dispose(): void };
}

export interface AliaVoiceTurnSenderOptions {
  readonly oxyServices: LinkedClientFactory;
  readonly apiUrl: string;
  /** `publisher/model`, checked against `GET /catalogue` like `useAliaChat`'s; omitted, the server's default. */
  readonly model?: string;
  readonly agentId?: string;
}

/** The default sender: `POST /v1/chat/completions` as `useAliaChat` sends it, marked as voice. */
export function createAliaVoiceTurnSender(options: AliaVoiceTurnSenderOptions): VoiceTurnSender {
  const { oxyServices, apiUrl, model, agentId } = options;
  return async ({ text, history, signal, onText }) => {
    const linked = oxyServices.createLinkedClient({ baseURL: apiUrl });
    try {
      const effectiveModel = await resolveModelId(apiUrl, model);
      signal.throwIfAborted();
      let answer = '';
      await streamAliaChat(
        linked.client,
        {
          url: '/v1/chat/completions',
          model: effectiveModel,
          messages: [...history, { role: 'user', content: text }],
          responseMode: 'voice',
          ...(agentId === undefined ? {} : { agentId }),
        },
        signal,
        (event) => {
          if (event.kind !== 'content' && event.kind !== 'agent_answer') return;
          answer += event.content;
          onText(answer);
        },
      );
    } finally {
      linked.dispose();
    }
  };
}

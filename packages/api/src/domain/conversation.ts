/**
 * Closed value sets and stored shapes for `conversation`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime.
 *
 * The stored shapes live here too. `db/schema/chat.ts` holds `content` and
 * `tool_invocations` as `jsonb`, which enforces nothing, so the only statement of what those columns hold is this file plus the
 * whitelist in `routes/conversations.ts` that admits them.
 */

export const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];
export const MESSAGE_VOTES = ['up', 'down'] as const;
export type MessageVote = (typeof MESSAGE_VOTES)[number];
/**
 * Where a conversation came from.
 *
 * ## `signal` is in the tuple because it is written
 *
 * `lib/channels/types.ts` declares five channels and `lib/channels/index.ts`
 * registers all five, so `routes/webhooks.ts` really does write
 * `source: 'signal'`.
 *
 * `conversations_source_check` checks it. Without `signal` in the tuple, every
 * Signal message would fail its upsert, be swallowed by the webhook's catch,
 * and reply "Sorry, an error occurred" forever — with the conversation never
 * persisted and no other symptom. `0027_signal_conversation_source` widened the
 * constraint to match.
 */
export const CONVERSATION_SOURCES = [
  'app',
  'telegram',
  'api',
  'web',
  'discord',
  'whatsapp',
  'slack',
  'signal',
] as const;
export type ConversationSource = (typeof CONVERSATION_SOURCES)[number];

/**
 * The Oxy app a conversation started in (`conversations.origin_app`), as the
 * embedding app names itself: its slug, the same name its host tools carry
 * (`host.app`, `docs/agent-embedding.md` §2 and §6). `null` is Alia's own
 * surfaces — the Alia app, the API, the channels.
 *
 * ## A listing label, never authority
 *
 * The value is the embedding client's own declaration, not the verified app
 * assertion (`lib/app-surface.ts`). That is deliberate:
 *
 *  - It only narrows the person's OWN list (`GET /v1/conversations?app=`). A
 *    client that mislabels a conversation mislabels it for the one person who
 *    could already read, rename and delete it; nothing anybody else can see or
 *    do depends on it. No reach, gate, tool or bill reads it, and none may.
 *  - The assertion names an Oxy application id, not the slug apps list by, and
 *    a native build proves itself only once its platform attestation is
 *    configured: a label that existed only where an assertion verified would
 *    leave the same app's conversations unlabelled on its phones.
 *
 * Confinement and every other access decision keep reading the assertion,
 * which is the one thing that proves an app (ADR 0021).
 */
export const ORIGIN_APP_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** The slug when `value` is one, else `undefined`. */
export function originAppOf(value: unknown): string | undefined {
  return typeof value === 'string' && ORIGIN_APP_PATTERN.test(value) ? value : undefined;
}

/**
 * The AI SDK's tool-call lifecycle.
 *
 * `tool_invocations` is `jsonb` and cannot carry a check, so the enforcement
 * lives at the one place a client can supply the value:
 * `routes/conversations.ts` normalises `POST /conversations` bodies against this
 * tuple. Every other writer produces it server-side in `lib/chat/stream-runner.ts`.
 */
export const TOOL_INVOCATION_STATES = ['partial-call', 'call', 'result'] as const;
export type ToolInvocationState = (typeof TOOL_INVOCATION_STATES)[number];

/**
 * One tool call attached to a message.
 *
 * `state` is `string` rather than {@link ToolInvocationState} because this is
 * also the READ type: the column is `jsonb` with no constraint, so what comes
 * back is whatever was written, including by a writer that predates the
 * normalisation. `args` and `result` are untyped — every tool has its own
 * shape and nothing queries inside them.
 */
export interface ToolInvocation {
  toolCallId: string;
  toolName: string;
  state: string;
  args?: unknown;
  result?: unknown;
}

/**
 * The agent that produced a message, when one did.
 *
 * A fixed sub-document this service composes itself, which is why
 * `db/schema/chat.ts` flattens it onto four columns rather than storing it as
 * `jsonb`.
 *
 * `color` stands where `avatar` did. An agent has no avatar: it is drawn as a
 * glyph tinted with its own Bloom colour preset, read from its Oxy account by
 * `lib/agent-identity.ts`. It is nullable for the reason that field is —
 * an account with no colour, an Oxy that does not serve one and an account that
 * failed to resolve are the same answer to a client.
 */
export interface AgentInfo {
  id: string;
  name: string;
  color: string | null;
  /**
   * The agent's look when it said this, a Bloom avatar character stored as the JSON object it is
   * (`AvatarCharacter` in `@oxy.so/contracts`); null when the agent is gone. Opaque here: a domain
   * module imports nothing, and this one only carries it.
   */
  character: object | null;
  handle: string;
}

/** One element of a multi-part message body. The shape is the AI SDK's. */
export interface MessageContentPart {
  type: string;
  [key: string]: unknown;
}

/**
 * A message body: plain text, or the ordered parts array the AI SDK sends.
 *
 * Genuinely polymorphic, which is the `jsonb` test — the format belongs to
 * somebody else. `db/__tests__/chat.pgdb.test.ts` asserts both JSON types reach
 * the column.
 */
export type MessageContent = string | MessageContentPart[];

/**
 * The client-message-id prefix of a message an agent wrote on its own — a
 * result it delivered, a check-in it chose to send — rather than one the
 * person's client sent or streamed.
 *
 * It is the only mark such a row carries (`messages` has no metadata column),
 * and it matters because the saver otherwise makes storage converge on the
 * client's copy of the conversation: a client that had not yet seen the
 * agent's message would delete it with its next turn.
 */
export const AGENT_OUTREACH_MESSAGE_ID_PREFIX = 'agent-push-';

export function isAgentOutreachMessageId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(AGENT_OUTREACH_MESSAGE_ID_PREFIX);
}

/**
 * The longest message id this service stores. The speech route caps the
 * `messageId` it looks up at the same length, so a longer one could be stored
 * and then never addressed.
 */
const MAX_MESSAGE_ID_LENGTH = 128;

/** A client-sent message id worth keeping: a non-empty string of bounded length. */
export function usableMessageId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_MESSAGE_ID_LENGTH
    ? value
    : undefined;
}

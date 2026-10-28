/**
 * Host tools: UI effects the embedding app performs on the person's screen
 * (Alia ADR 0020 §6, `docs/agent-embedding.md` §2).
 *
 * An app that embeds a conversation through `@alia.onl/sdk` declares, per
 * request, what its own client can do — open a listing, apply a search, switch
 * a view. The model sees each as `host_<app>__<name>`. Calling one does nothing
 * here: Alia records the call, emits `alia.host_action` to the client that
 * declared it, and tells the model the action was dispatched. The client
 * carries it out and sends the outcome with the NEXT request
 * (`host.outcomes`), which becomes that call's result — in the model's context
 * and in the stored conversation — so the model knows what actually happened.
 *
 * A host tool may instead await its result (`awaitsResult: true`): the model reads what the app
 * answered in the SAME turn ("this tab's text", "the open tabs"). Its `alia.host_action` carries
 * `awaitsResult` and the turn id, and the turn waits for the client's answer on
 * `POST /v1/chat/turns/:turnId/host-results` (`lib/chat/host-results.ts`), bounded by
 * `HOST_RESULT_WAIT_MS`. Such tools need the explicit-Stop turn id and a person's own streamed
 * session; the request is refused otherwise (`lib/chat/request-context.ts`).
 *
 * An awaited result may be an image (`{ type: 'image', mediaType, data, text? }`, a screenshot):
 * the model reads it as an image beside the outcome's text ({@link hostResultModelOutput}), never as
 * base64 inside JSON. It reaches a model only on a level or model that sees; Oxy refuses any other
 * with `unsupported_modality`.
 *
 * A host tool is never authority over data: the person's data is reached only
 * through their apps' catalogue tools, which Oxy authorizes per call. It is
 * also separate from the editor lane (`body.tools`), whose tools a developer
 * client executes and whose contract is unchanged.
 */
import { jsonObjectSchemaToZod } from '@oxy.so/mcp';
import { jsonSchema, tool, type ModelMessage, type ToolResultPart, type ToolSet } from 'ai';
import { z } from 'zod';
import { ORIGIN_APP_PATTERN } from '../domain/conversation.js';
import type { SSEEmitter } from './sse-emitter.js';
import { HOST_TOOL_OUTCOMES } from '../domain/chat-host-results.js';
import type { HostResultAnswer, HostResultKey } from '../db/chat/hostResultRepository.js';
import type { TurnIdentity } from '../db/chat/turnControlRepository.js';

export { HOST_TOOL_OUTCOMES, type HostToolOutcome } from '../domain/chat-host-results.js';

const MAX_HOST_TOOLS = 16;
const MAX_OUTCOMES = 32;

const hostToolDefinitionSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
    description: z.string().trim().min(1).max(1024),
    inputSchema: z
      .record(z.string(), z.unknown())
      .refine((schema) => schema.type === 'object', 'inputSchema must have an object root'),
    /** The model reads the client's answer in this same turn (`lib/chat/host-results.ts`). */
    awaitsResult: z.literal(true).optional(),
  })
  .strict();

const hostOutcomeSchema = z
  .object({
    toolCallId: z.string().min(1).max(128),
    outcome: z.enum(HOST_TOOL_OUTCOMES),
    detail: z.string().max(500).optional(),
  })
  .strict();

export const hostRequestSchema = z
  .object({
    /** The embedding app's slug; it also labels a conversation the turn starts. */
    app: z.string().regex(ORIGIN_APP_PATTERN),
    version: z.literal(1),
    tools: z.array(hostToolDefinitionSchema).max(MAX_HOST_TOOLS),
    outcomes: z.array(hostOutcomeSchema).max(MAX_OUTCOMES).optional(),
  })
  .strict()
  .superRefine((host, context) => {
    const names = new Set<string>();
    for (const [index, definition] of host.tools.entries()) {
      if (names.has(definition.name)) {
        context.addIssue({
          code: 'custom',
          path: ['tools', index, 'name'],
          message: `Duplicate host tool: ${definition.name}`,
        });
      }
      names.add(definition.name);
    }
  });

export type HostRequest = z.infer<typeof hostRequestSchema>;
export type HostOutcome = z.infer<typeof hostOutcomeSchema>;

/** `undefined` when the request declared no host; an error message when it declared one badly. */
export function parseHostRequest(
  raw: unknown,
): { ok: true; host: HostRequest | undefined } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, host: undefined };
  const parsed = hostRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      message: `Invalid host: ${issue ? `${issue.path.join('.') || 'host'}: ${issue.message}` : 'malformed'}`,
    };
  }
  for (const definition of parsed.data.tools) {
    try {
      jsonObjectSchemaToZod(definition.inputSchema);
    } catch {
      return { ok: false, message: `Invalid host: tools.${definition.name}.inputSchema` };
    }
  }
  return { ok: true, host: parsed.data };
}

export function hostToolName(app: string, name: string): string {
  return `host_${app.replace(/-/g, '_')}__${name}`;
}

/** The dispatched answer the model reads until the outcome arrives. */
export const HOST_TOOL_DISPATCHED = {
  status: 'dispatched',
  message:
    "The app is carrying this out on the person's screen. Its outcome arrives with their next message; do not claim it succeeded and do not repeat it.",
} as const;

/** Whether the request declares a host tool that awaits its result. */
export function hostAwaitsResults(host: HostRequest | undefined): boolean {
  return host?.tools.some((definition) => definition.awaitsResult === true) === true;
}

/** What the model reads when the app did not answer an awaited action in time. */
export const HOST_RESULT_STALE = {
  status: 'stale',
  detail: 'The app did not answer in time.',
} as const;

/** Where an awaited host action is recorded and its answer awaited (`HostResultWaiter`). */
export interface HostResultChannel {
  open(key: HostResultKey): Promise<void>;
  wait(key: HostResultKey, signal: AbortSignal | undefined): Promise<HostResultAnswer | null>;
}

/** The turn an awaited host action belongs to, and the channel its answer comes back on. */
export interface AwaitedHostTurn {
  turn: TurnIdentity;
  results: HostResultChannel;
}

/**
 * One tool per declared host action, emitting `alia.host_action` when called. A tool that awaits
 * its result is built only with `awaited`, the turn its answer is bound to.
 */
export function buildHostTools(
  host: HostRequest,
  emitter: SSEEmitter,
  awaited?: AwaitedHostTurn,
): ToolSet {
  const tools: ToolSet = {};
  for (const definition of host.tools) {
    if (definition.awaitsResult && !awaited) continue;
    const validator = jsonObjectSchemaToZod(definition.inputSchema);
    tools[hostToolName(host.app, definition.name)] = tool({
      description: `[In the app on the person's screen] ${definition.description}`,
      inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema, {
        validate: (value) => {
          const parsed = validator.safeParse(value);
          return parsed.success
            ? { success: true, value: parsed.data as Record<string, unknown> }
            : { success: false, error: new Error('Input does not match the host tool schema') };
        },
      }),
      execute: async (
        input: Record<string, unknown>,
        { toolCallId, abortSignal }: { toolCallId: string; abortSignal?: AbortSignal },
      ) => {
        const action = {
          eventVersion: 1,
          toolCallId,
          app: host.app,
          name: definition.name,
          input,
        };
        if (!definition.awaitsResult || !awaited) {
          emitter.emit('alia.host_action', action);
          return HOST_TOOL_DISPATCHED;
        }
        const key = {
          turnId: awaited.turn.id,
          toolCallId,
          authorityKey: awaited.turn.authorityKey,
        };
        try {
          await awaited.results.open(key);
        } catch {
          return { status: 'failed', detail: 'The app could not be asked.' };
        }
        emitter.emit('alia.host_action', { ...action, awaitsResult: true, turnId: key.turnId });
        const answer = await awaited.results.wait(key, abortSignal);
        return answer ? hostOutcomeResult(answer) : HOST_RESULT_STALE;
      },
      toModelOutput: ({ output }: { output: unknown }) => hostResultModelOutput(output),
    });
  }
  return tools;
}

/** What the model reads as a host call's result once the client reported it. */
export function hostOutcomeResult(
  outcome: Pick<HostOutcome, 'outcome' | 'detail'> & { result?: unknown },
): Record<string, unknown> {
  return {
    status: outcome.outcome,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
    ...(outcome.result === undefined ? {} : { result: outcome.result }),
  };
}

/**
 * Replace each reported call's dispatched result with its outcome, in the
 * messages the model is about to read. A call the history does not contain is
 * ignored: an outcome is a fact about an earlier call, never a new one.
 */
export function applyHostOutcomes(
  messages: ModelMessage[],
  outcomes: readonly HostOutcome[] | undefined,
): ModelMessage[] {
  if (!outcomes?.length) return messages;
  const byCall = new Map(outcomes.map((outcome) => [outcome.toolCallId, outcome]));
  return messages.map((message) => {
    if (message.role !== 'tool') return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result') return part;
      const outcome = byCall.get(part.toolCallId);
      if (!outcome) return part;
      changed = true;
      return {
        ...part,
        output: { type: 'text' as const, value: JSON.stringify(hostOutcomeResult(outcome)) },
      };
    });
    return changed ? { ...message, content } : message;
  });
}

/** The image formats an awaited host result may carry: the four every route that sees reads. */
export const HOST_IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

/**
 * The most decoded bytes one host image may carry: Oxy's and Kaana's per-image bound
 * (`MAX_INPUT_IMAGE_BYTES`, `@kaana.ai/contracts` 8.1.0). The host-results bound of
 * `HOST_RESULT_MAX_CHARS` already keeps a screenshot far below it.
 */
export const HOST_IMAGE_MAX_BYTES = 3_750_000;

export interface HostImage {
  readonly mediaType: (typeof HOST_IMAGE_MEDIA_TYPES)[number];
  readonly data: string;
  readonly text?: string;
}

const BASE64_BODY = /^[A-Za-z0-9+/]*$/;

/** The decoded length of canonical, padded base64, or `undefined` when it is not that. */
export function base64DecodedLength(data: string): number | undefined {
  if (data.length === 0 || data.length % 4 !== 0) return undefined;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  if (!BASE64_BODY.test(data.slice(0, data.length - padding))) return undefined;
  return (data.length / 4) * 3 - padding;
}

/**
 * The image an awaited host result carries: the image, `'invalid'` when the result says it is an
 * image and breaks the rules (format, canonical base64, byte bound), or `undefined` when it is not
 * an image at all.
 */
export function hostImageOf(result: unknown): HostImage | 'invalid' | undefined {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return undefined;
  const candidate = result as Record<string, unknown>;
  if (candidate.type !== 'image') return undefined;
  const { mediaType, data, text } = candidate;
  if (
    typeof mediaType !== 'string' ||
    !(HOST_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType) ||
    typeof data !== 'string' ||
    (text !== undefined && typeof text !== 'string')
  ) {
    return 'invalid';
  }
  const bytes = base64DecodedLength(data);
  if (bytes === undefined || bytes > HOST_IMAGE_MAX_BYTES) return 'invalid';
  return {
    mediaType: mediaType as HostImage['mediaType'],
    data,
    ...(text === undefined ? {} : { text }),
  };
}

/** What the model reads when the app's image could not be shown to it. */
export const HOST_IMAGE_INVALID_DETAIL =
  'The app returned an image the model cannot be shown (it must be PNG, JPEG, WebP or GIF, canonical base64, at most 3,750,000 bytes).';

/**
 * What the model reads for a host call's result (its `toModelOutput`, and the replay of a stored
 * one). An image result becomes the outcome's text (status, detail and the image's own text, never
 * its data) followed by the image itself; an image that breaks the rules becomes text saying so,
 * without the data. Anything else is what the AI SDK sends by default: text for a string, JSON
 * otherwise.
 */
export function hostResultModelOutput(output: unknown): ToolResultPart['output'] {
  if (typeof output === 'string') return { type: 'text', value: output };
  if (
    typeof output === 'object' &&
    output !== null &&
    !Array.isArray(output) &&
    'result' in output
  ) {
    const { result, ...rest } = output as Record<string, unknown>;
    const image = hostImageOf(result);
    if (image === 'invalid') {
      return {
        type: 'text',
        value: JSON.stringify({ ...rest, detail: HOST_IMAGE_INVALID_DETAIL }),
      };
    }
    if (image !== undefined) {
      return {
        type: 'content',
        value: [
          {
            type: 'text',
            text: JSON.stringify({
              ...rest,
              ...(image.text === undefined ? {} : { text: image.text }),
            }),
          },
          { type: 'image-data', data: image.data, mediaType: image.mediaType },
        ],
      };
    }
  }
  return { type: 'json', value: (output ?? null) as never };
}

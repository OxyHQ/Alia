/**
 * A call's tools: serialized for the Kaana session and executed in Alia only
 * (ADR 0017 §3, "Tools").
 *
 * Kaana relays `tool_call` to its client and expects a `function_call_output`
 * back; Alia is that client, so every tool runs here, for the authenticated
 * person on the socket, and the device never sees a schema, the arguments or
 * a result. The set is `ToolPipeline.forUser`'s, so the owner's data reaches
 * an agent's tools only when the owner is the one talking (ADR 0015).
 */

import { asSchema, type Tool, type ToolSet } from 'ai';
import {
  MAX_REALTIME_ITEM_TEXT_CHARS,
  type RealtimeSessionConfig,
  realtimeToolDefinitionSchema,
} from '@kaana.ai/contracts';

/** One tool as the session declares it. */
type RealtimeToolDefinition = NonNullable<RealtimeSessionConfig['tools']>[number];

/** A tool call that runs longer than this answers the model with a typed tool error. */
export const VOICE_TOOL_TIMEOUT_MS = 60_000;

/** The contract's bound on a tool's description, read from its schema. */
const MAX_DESCRIPTION_CHARS =
  realtimeToolDefinitionSchema.shape.description.unwrap().maxLength ?? Number.POSITIVE_INFINITY;

/** The JSON Schema of a tool's input, or an empty object schema when it cannot be read synchronously. */
function parametersOf(built: Tool): Record<string, unknown> {
  try {
    const schema: unknown = asSchema(built.inputSchema).jsonSchema;
    if (
      schema !== null &&
      typeof schema === 'object' &&
      typeof (schema as { then?: unknown }).then !== 'function'
    )
      return schema as Record<string, unknown>;
  } catch {
    // A schema that cannot be serialized is sent as "any object".
  }
  return { type: 'object', properties: {} };
}

/**
 * The session's tool definitions: the named tools, in the given order. The
 * names are the routed active set (`lib/tool-budget.ts`), already within one
 * request's tool count; a set the contract would not take is refused by the
 * SDK's own check of the open, with its `param`, never trimmed here.
 */
export function toRealtimeTools(
  tools: ToolSet,
  names: readonly string[],
): RealtimeToolDefinition[] {
  const definitions: RealtimeToolDefinition[] = [];
  for (const name of names) {
    const built = tools[name];
    if (!built || typeof built.execute !== 'function') continue;
    definitions.push({
      type: 'function',
      name,
      ...(built.description
        ? { description: built.description.slice(0, MAX_DESCRIPTION_CHARS) }
        : {}),
      parameters: parametersOf(built),
    });
  }
  return definitions;
}

export interface ToolRunResult {
  readonly ok: boolean;
  /** What the model receives as the call's output. */
  readonly output: string;
  /** What is stored on the message (the tool's own result, or the error). */
  readonly result: unknown;
}

function serialize(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  } catch {
    text = String(value);
  }
  return text.slice(0, MAX_REALTIME_ITEM_TEXT_CHARS);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

/**
 * Run one tool by name with the arguments the model streamed.
 *
 * Never throws: an unknown tool, unparseable arguments, a failure and a timeout
 * each come back as a typed tool error the model reads — never an invented
 * result. A tool that streams preliminary results answers with its last one.
 */
export async function runTool(
  tools: ToolSet,
  name: string,
  rawArguments: string,
  options: { toolCallId: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<ToolRunResult> {
  const failure = (type: string, message: string): ToolRunResult => {
    const result = { error: { type, message } };
    return { ok: false, output: serialize(result), result };
  };
  const built = tools[name];
  if (!built || typeof built.execute !== 'function')
    return failure('unknown_tool', `No tool named ${name} is available in this call.`);

  let args: unknown;
  try {
    args = rawArguments.trim() === '' ? {} : JSON.parse(rawArguments);
  } catch {
    return failure('invalid_arguments', 'The tool arguments were not valid JSON.');
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const timeoutMs = options.timeoutMs ?? VOICE_TOOL_TIMEOUT_MS;
  try {
    const running = (async () => {
      const value: unknown = await built.execute!(args as never, {
        toolCallId: options.toolCallId,
        messages: [],
        abortSignal: controller.signal,
      });
      if (!isAsyncIterable(value)) return value;
      let last: unknown;
      for await (const part of value) last = part;
      return last;
    })();
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const outcome = await Promise.race([running, timedOut]);
    if (outcome === 'timeout') {
      controller.abort();
      running.catch(() => undefined);
      return failure(
        'tool_timeout',
        `The tool did not finish within ${Math.round(timeoutMs / 1000)} s.`,
      );
    }
    return { ok: true, output: serialize(outcome), result: outcome };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'The tool failed.';
    return failure('tool_failed', message);
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

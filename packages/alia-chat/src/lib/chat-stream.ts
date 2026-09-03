import type { PlanStep, ResearchProgress, ResearchSource } from '../types';

const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_STREAM_LINES = 65_536;
const MAX_BUFFER_BYTES = 1024 * 1024;

type JsonObject = Record<string, unknown>;

export type AliaChatStreamEvent =
  | { readonly kind: 'content'; readonly content: string }
  | { readonly kind: 'reasoning'; readonly content: string }
  | {
      readonly kind: 'tool_call';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: Record<string, unknown>;
    }
  | {
      readonly kind: 'tool_result';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly output: unknown;
    }
  | { readonly kind: 'research_progress'; readonly progress: ResearchProgress }
  | {
      readonly kind: 'plan_preview';
      readonly planId: string;
      readonly steps: PlanStep[];
    }
  | {
      readonly kind: 'agent_answer';
      readonly content: string;
      readonly agent: { readonly id: string; readonly name: string; readonly avatar: null };
    };

export interface AliaChatStreamResult {
  readonly answerReceived: true;
  readonly finishReason: string;
}

export class AliaChatStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AliaChatStreamError';
  }
}

function abortError(): Error {
  const error = new Error('The Alia stream was aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function fail(message: string): never {
  throw new AliaChatStreamError(message);
}

function asObject(value: unknown, context: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${context} must be an object.`);
  }
  return value as JsonObject;
}

function assertOnlyKeys(value: JsonObject, allowed: readonly string[], context: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) fail(`${context} contains unsupported field ${unknown}.`);
}

function asString(value: unknown, context: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    fail(`${context} must be a non-empty string.`);
  }
  return value;
}

function asOptionalString(value: unknown, context: string): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, context, true);
}

function asOptionalNumber(value: unknown, context: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${context} must be a finite number.`);
  }
  return value;
}

function asStringArray(value: unknown, context: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(`${context} must be an array.`);
  return value.map((entry, index) => asString(entry, `${context}[${index}]`));
}

function requireEventVersion(payload: JsonObject, eventName: string): void {
  if (payload.eventVersion !== 1) {
    fail(`${eventName} has an unsupported eventVersion.`);
  }
}

function parsePlanSteps(value: unknown): PlanStep[] {
  if (!Array.isArray(value) || value.length < 2) {
    fail('alia.plan_preview steps must contain at least two entries.');
  }

  return value.map((entry, index) => {
    const step = asObject(entry, `alia.plan_preview steps[${index}]`);
    assertOnlyKeys(step, ['action', 'description', 'toolName'], `alia.plan_preview steps[${index}]`);
    return {
      action: asString(step.action, `alia.plan_preview steps[${index}].action`),
      description: asString(step.description, `alia.plan_preview steps[${index}].description`),
      ...(step.toolName === undefined
        ? {}
        : { toolName: asString(step.toolName, `alia.plan_preview steps[${index}].toolName`) }),
    };
  });
}

function parseResearchSources(value: unknown): ResearchSource[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail('alia.research_progress sources must be an array.');

  return value.map((entry, index) => {
    const source = asObject(entry, `alia.research_progress sources[${index}]`);
    assertOnlyKeys(source, ['id', 'url', 'title'], `alia.research_progress sources[${index}]`);
    if (typeof source.id !== 'number' || !Number.isSafeInteger(source.id)) {
      fail(`alia.research_progress sources[${index}].id must be an integer.`);
    }
    return {
      id: source.id,
      url: asString(source.url, `alia.research_progress sources[${index}].url`),
      title: asString(source.title, `alia.research_progress sources[${index}].title`, true),
    };
  });
}

function parseResearchProgress(payload: JsonObject): ResearchProgress {
  requireEventVersion(payload, 'alia.research_progress');
  assertOnlyKeys(
    payload,
    [
      'eventVersion',
      'phase',
      'message',
      'subQuestions',
      'sourcesFound',
      'currentQuery',
      'iteration',
      'sources',
      'totalSearches',
    ],
    'alia.research_progress',
  );
  const phase = asString(payload.phase, 'alia.research_progress phase');
  const sources = parseResearchSources(payload.sources);

  return {
    phase,
    message: asOptionalString(payload.message, 'alia.research_progress message'),
    subQuestions: asStringArray(payload.subQuestions, 'alia.research_progress subQuestions'),
    sourcesFound: asOptionalNumber(payload.sourcesFound, 'alia.research_progress sourcesFound'),
    currentQuery: asOptionalString(payload.currentQuery, 'alia.research_progress currentQuery'),
    iteration: asOptionalNumber(payload.iteration, 'alia.research_progress iteration'),
    isComplete: phase === 'complete',
    sources,
    totalSearches: asOptionalNumber(payload.totalSearches, 'alia.research_progress totalSearches'),
  };
}

function validateIgnoredNamedEvent(eventName: string, payload: JsonObject): void {
  requireEventVersion(payload, eventName);

  switch (eventName) {
    case 'alia.model_switch':
      assertOnlyKeys(payload, ['eventVersion', 'model', 'modelName'], eventName);
      asString(payload.model, `${eventName} model`);
      asString(payload.modelName, `${eventName} modelName`);
      return;
    case 'alia.suggest_new_conversation':
      assertOnlyKeys(payload, ['eventVersion', 'reason'], eventName);
      asString(payload.reason, `${eventName} reason`);
      return;
    case 'alia.agent_session':
      assertOnlyKeys(payload, ['eventVersion', 'sessionId', 'agentId', 'agentName'], eventName);
      asString(payload.sessionId, `${eventName} sessionId`);
      asString(payload.agentId, `${eventName} agentId`);
      asString(payload.agentName, `${eventName} agentName`);
      return;
    case 'alia.title':
      assertOnlyKeys(payload, ['eventVersion', 'title', 'conversationId'], eventName);
      asString(payload.title, `${eventName} title`);
      asString(payload.conversationId, `${eventName} conversationId`);
      return;
    case 'alia.deprecation':
      assertOnlyKeys(
        payload,
        ['eventVersion', 'identifier', 'replacement', 'deprecatedAt', 'sunsetAt', 'documentation'],
        eventName,
      );
      asString(payload.identifier, `${eventName} identifier`);
      asString(payload.replacement, `${eventName} replacement`);
      asString(payload.deprecatedAt, `${eventName} deprecatedAt`);
      if (payload.sunsetAt !== null) asString(payload.sunsetAt, `${eventName} sunsetAt`);
      asString(payload.documentation, `${eventName} documentation`);
      return;
    case 'alia.route_switch': {
      assertOnlyKeys(payload, ['eventVersion', 'reason', 'scope', 'occurredAt'], eventName);
      const reasons = new Set([
        'deployment_unavailable',
        'provider_error',
        'provider_timeout',
        'provider_overloaded',
        'rate_limited',
        'capacity',
        'policy_preference',
      ]);
      const scopes = new Set(['same_model_revision', 'same_model', 'cross_model']);
      const reason = asString(payload.reason, `${eventName} reason`);
      const scope = asString(payload.scope, `${eventName} scope`);
      if (!reasons.has(reason) || !scopes.has(scope)) fail(`${eventName} has an unsupported route switch.`);
      asString(payload.occurredAt, `${eventName} occurredAt`);
      return;
    }
    default:
      fail(`Unsupported Alia stream event: ${eventName}.`);
  }
}

function parseNamedEvent(eventName: string, payload: unknown): AliaChatStreamEvent | null {
  const body = asObject(payload, eventName);
  requireEventVersion(body, eventName);

  switch (eventName) {
    case 'alia.reasoning':
      assertOnlyKeys(body, ['eventVersion', 'content'], eventName);
      return { kind: 'reasoning', content: asString(body.content, `${eventName} content`) };
    case 'alia.tool_result':
      assertOnlyKeys(body, ['eventVersion', 'tool_call_id', 'name', 'output'], eventName);
      if (!Object.hasOwn(body, 'output')) fail(`${eventName} output is required.`);
      return {
        kind: 'tool_result',
        toolCallId: asString(body.tool_call_id, `${eventName} tool_call_id`),
        toolName: asString(body.name, `${eventName} name`),
        output: body.output,
      };
    case 'alia.research_progress':
      return { kind: 'research_progress', progress: parseResearchProgress(body) };
    case 'alia.plan_preview':
      assertOnlyKeys(body, ['eventVersion', 'planId', 'steps'], eventName);
      return {
        kind: 'plan_preview',
        planId: asString(body.planId, `${eventName} planId`),
        steps: parsePlanSteps(body.steps),
      };
    case 'alia.agent': {
      assertOnlyKeys(
        body,
        ['eventVersion', 'agentId', 'agentName', 'agentHandle', 'agentColor', 'content'],
        eventName,
      );
      if (body.agentColor !== null) asString(body.agentColor, `${eventName} agentColor`);
      asString(body.agentHandle, `${eventName} agentHandle`);
      return {
        kind: 'agent_answer',
        content: asString(body.content, `${eventName} content`),
        agent: {
          id: asString(body.agentId, `${eventName} agentId`),
          name: asString(body.agentName, `${eventName} agentName`),
          avatar: null,
        },
      };
    }
    default:
      validateIgnoredNamedEvent(eventName, body);
      return null;
  }
}

function parseToolCalls(value: unknown): AliaChatStreamEvent[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail('OpenAI tool_calls must be a non-empty array.');
  }

  return value.map((entry, index) => {
    const call = asObject(entry, `tool_calls[${index}]`);
    assertOnlyKeys(call, ['index', 'id', 'type', 'function'], `tool_calls[${index}]`);
    if (typeof call.index !== 'number' || !Number.isSafeInteger(call.index)) {
      fail(`tool_calls[${index}].index must be an integer.`);
    }
    if (call.type !== 'function') fail(`tool_calls[${index}].type must be function.`);
    const fn = asObject(call.function, `tool_calls[${index}].function`);
    assertOnlyKeys(fn, ['name', 'arguments'], `tool_calls[${index}].function`);
    const encodedArgs = asString(fn.arguments, `tool_calls[${index}].function.arguments`, true);
    let decodedArgs: unknown;
    try {
      decodedArgs = JSON.parse(encodedArgs);
    } catch {
      fail(`tool_calls[${index}].function.arguments is not valid JSON.`);
    }

    return {
      kind: 'tool_call' as const,
      toolCallId: asString(call.id, `tool_calls[${index}].id`),
      toolName: asString(fn.name, `tool_calls[${index}].function.name`),
      args: asObject(decodedArgs, `tool_calls[${index}].function.arguments`),
    };
  });
}

interface ParsedOpenAIFrame {
  readonly events: AliaChatStreamEvent[];
  readonly finishReason: string | null;
}

function parseOpenAIFrame(payload: unknown): ParsedOpenAIFrame {
  const body = asObject(payload, 'OpenAI stream frame');
  if (body.error !== undefined) {
    const error = asObject(body.error, 'OpenAI stream error');
    asString(error.message, 'OpenAI stream error message');
    fail('Alia ended the stream with an error.');
  }
  assertOnlyKeys(
    body,
    [
      'id',
      'object',
      'created',
      'model',
      'system_fingerprint',
      'service_tier',
      'choices',
      'usage',
      'alia_usage',
      'alia_meta',
    ],
    'OpenAI stream frame',
  );
  if (body.object !== 'chat.completion.chunk') {
    fail('Unexpected object in the Alia stream.');
  }
  asString(body.id, 'OpenAI stream frame id');
  asString(body.model, 'OpenAI stream frame model');
  if (typeof body.created !== 'number' || !Number.isSafeInteger(body.created)) {
    fail('OpenAI stream frame created must be an integer.');
  }
  if (!Array.isArray(body.choices)) fail('OpenAI stream frame choices must be an array.');

  if (body.choices.length === 0) {
    asObject(body.usage, 'OpenAI usage frame usage');
    return { events: [], finishReason: null };
  }
  if (body.choices.length !== 1) fail('OpenAI stream frame must contain exactly one choice.');

  const events: AliaChatStreamEvent[] = [];
  let finishReason: string | null = null;
  for (const [index, rawChoice] of body.choices.entries()) {
    const choice = asObject(rawChoice, `choices[${index}]`);
    assertOnlyKeys(choice, ['index', 'delta', 'finish_reason', 'logprobs'], `choices[${index}]`);
    if (typeof choice.index !== 'number' || !Number.isSafeInteger(choice.index)) {
      fail(`choices[${index}].index must be an integer.`);
    }
    if (choice.index !== 0) fail(`choices[${index}].index must be zero.`);
    const delta = asObject(choice.delta, `choices[${index}].delta`);
    const allowedDeltaKeys = new Set(['content', 'reasoning', 'role', 'tool_calls']);
    for (const key of Object.keys(delta)) {
      if (!allowedDeltaKeys.has(key)) fail(`Unsupported OpenAI delta field: ${key}.`);
    }
    if (delta.role !== undefined && delta.role !== 'assistant') {
      fail(`choices[${index}].delta.role must be assistant.`);
    }
    if (delta.content !== undefined) {
      events.push({ kind: 'content', content: asString(delta.content, `choices[${index}].delta.content`, true) });
    }
    if (delta.reasoning !== undefined) {
      events.push({ kind: 'reasoning', content: asString(delta.reasoning, `choices[${index}].delta.reasoning`) });
    }
    if (delta.tool_calls !== undefined) events.push(...parseToolCalls(delta.tool_calls));

    if (choice.finish_reason !== null) {
      const current = asString(choice.finish_reason, `choices[${index}].finish_reason`);
      if (finishReason !== null && finishReason !== current) {
        fail('OpenAI stream frame contains conflicting finish reasons.');
      }
      finishReason = current;
    }
  }

  return { events, finishReason };
}

interface SSEFrame {
  eventName: string;
  data: string;
}

function parseSSEFrame(rawFrame: string): SSEFrame | null {
  const lines = rawFrame.split('\n');
  let eventName = '';
  let data: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '' || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      if (eventName !== '') fail('An SSE frame contains more than one event field.');
      eventName = line.slice(6).trimStart();
      if (eventName.trim().length === 0) fail('An SSE event name cannot be empty.');
      continue;
    }
    if (line.startsWith('data:')) {
      if (data !== null) fail('An SSE frame contains more than one data field.');
      data = line.slice(5).trimStart();
      continue;
    }
    fail('The Alia response contains an unsupported SSE field.');
  }

  if (data === null) {
    if (eventName !== '') fail('A named SSE event is missing its data field.');
    return null;
  }
  return { eventName, data };
}

function splitNextFrame(buffer: string): { frame: string; rest: string } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) {
    return { frame: buffer.slice(0, crlf), rest: buffer.slice(crlf + 4) };
  }
  return { frame: buffer.slice(0, lf), rest: buffer.slice(lf + 2) };
}

/**
 * Consume the exact Alia product stream carried on the compatibility endpoint.
 * A successful result means an answer, a finish chunk and the terminal [DONE]
 * sentinel were all observed. Anything less is a failed turn.
 */
export async function consumeAliaChatStream(
  response: Response,
  onEvent: (event: AliaChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<AliaChatStreamResult> {
  if (signal?.aborted) {
    await response.body?.cancel().catch(() => undefined);
    throw abortError();
  }
  const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mime !== 'text/event-stream') {
    await response.body?.cancel().catch(() => undefined);
    fail('Alia returned a non-streaming response.');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    fail('Alia returned no readable stream.');
  }

  const reader = response.body.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let totalBytes = 0;
  let lineCount = 0;
  let answerReceived = false;
  let finishReason: string | null = null;
  let doneReceived = false;

  const dispatch = (frame: SSEFrame): void => {
    if (doneReceived) fail('The Alia stream continued after [DONE].');
    if (frame.data === '[DONE]') {
      if (frame.eventName !== '') fail('[DONE] must be an unnamed SSE data frame.');
      if (finishReason === null) fail('The Alia stream ended without a finish chunk.');
      if (!answerReceived) fail('Alia completed without an assistant answer.');
      doneReceived = true;
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      fail('The Alia stream contains malformed JSON.');
    }

    if (frame.eventName !== '') {
      const event = parseNamedEvent(frame.eventName, payload);
      if (event !== null) {
        if (event.kind === 'agent_answer') answerReceived = true;
        onEvent(event);
      }
      return;
    }

    const parsed = parseOpenAIFrame(payload);
    if (finishReason !== null && parsed.events.length > 0) {
      fail('The Alia stream emitted content after its finish chunk.');
    }
    for (const event of parsed.events) {
      if (event.kind === 'content' && event.content.trim().length > 0) answerReceived = true;
      onEvent(event);
    }
    if (parsed.finishReason !== null) {
      if (finishReason !== null) fail('The Alia stream contains more than one finish chunk.');
      finishReason = parsed.finishReason;
    }
  };

  try {
    while (true) {
      throwIfAborted(signal);
      const chunk = await reader.read();
      throwIfAborted(signal);
      if (chunk.done) {
        buffer += decoder.decode();
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_STREAM_BYTES) fail('The Alia stream exceeded its byte limit.');
      buffer += decoder.decode(chunk.value, { stream: true });

      let next = splitNextFrame(buffer);
      while (next !== null) {
        throwIfAborted(signal);
        buffer = next.rest;
        lineCount += next.frame.split('\n').length;
        if (lineCount > MAX_STREAM_LINES) fail('The Alia stream exceeded its line limit.');
        const frame = parseSSEFrame(next.frame);
        if (frame !== null) dispatch(frame);
        next = splitNextFrame(buffer);
      }
      if (buffer.length > MAX_BUFFER_BYTES) fail('The Alia stream contains an oversized frame.');
      if (doneReceived) {
        if (buffer.trim().length > 0) fail('The Alia stream continued after [DONE].');
        await reader.cancel().catch(() => undefined);
        break;
      }
    }

    if (buffer.trim().length > 0) fail('The Alia stream ended inside an SSE frame.');
    if (!doneReceived || finishReason === null || !answerReceived) {
      fail('The Alia stream ended before completing an assistant answer.');
    }
    return { answerReceived: true, finishReason };
  } catch (error: unknown) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

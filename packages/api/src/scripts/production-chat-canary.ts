import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { oxyServiceToken } from '../lib/oxy-service-client.js';

type Case = Readonly<{
  label: string;
  model: string;
  prompt: string;
  marker: string;
  deepResearch?: boolean;
  tools?: readonly Record<string, unknown>[];
  expectRefusal?: boolean;
  expectTool?: boolean;
}>;

export const PRODUCTION_CANARY_CASES: readonly Case[] = [
  {
    label: 'instant-1',
    model: 'route:instant',
    prompt: 'Reply exactly QA_INSTANT_OK_1.',
    marker: 'QA_INSTANT_OK_1',
  },
  {
    label: 'instant-2',
    model: 'route:instant',
    prompt: 'Reply exactly QA_INSTANT_OK_2.',
    marker: 'QA_INSTANT_OK_2',
  },
  {
    label: 'auto-1',
    model: 'route:auto',
    prompt: 'Reply exactly QA_AUTO_OK_1.',
    marker: 'QA_AUTO_OK_1',
  },
  {
    label: 'auto-2',
    model: 'route:auto',
    prompt: 'Reply exactly QA_AUTO_OK_2.',
    marker: 'QA_AUTO_OK_2',
  },
  {
    label: 'thinking-1',
    model: 'route:thinking',
    prompt: 'Calculate 17 + 25 and end with QA_THINKING_OK_42.',
    marker: 'QA_THINKING_OK_42',
  },
  {
    label: 'thinking-2',
    model: 'route:thinking',
    prompt: 'Calculate 19 + 24 and end with QA_THINKING_OK_43.',
    marker: 'QA_THINKING_OK_43',
  },
  {
    label: 'research-1',
    model: 'route:research',
    prompt: 'End your answer with QA_RESEARCH_OK_1.',
    marker: 'QA_RESEARCH_OK_1',
    deepResearch: true,
  },
  {
    label: 'research-2',
    model: 'route:research',
    prompt: 'End your answer with QA_RESEARCH_OK_2.',
    marker: 'QA_RESEARCH_OK_2',
    deepResearch: true,
  },
  {
    label: 'search-tool',
    model: 'route:auto',
    prompt:
      'Use web search for the official React documentation. Include https://react.dev and end with QA_SEARCH_OK.',
    marker: 'QA_SEARCH_OK',
    expectTool: true,
    tools: [
      {
        type: 'function',
        function: {
          name: 'webSearch',
          description: 'Search the public web.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          },
        },
      },
    ],
  },
  {
    label: 'controlled-refusal',
    model: 'route:not-registered',
    prompt: 'Refuse this unknown profile.',
    marker: '',
    expectRefusal: true,
  },
  {
    label: 'recovery',
    model: 'route:auto',
    prompt: 'Reply exactly QA_RECOVERY_OK.',
    marker: 'QA_RECOVERY_OK',
  },
];

const SAFE_CODES = new Set([
  'INVALID_REQUEST',
  'MODEL_NOT_FOUND',
  'REQUEST_REFUSED',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'ROUTING_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

export interface SafeResult {
  label: string;
  reference: string | null;
  code: string | null;
  retryable: boolean | null;
  synthetic: boolean;
  done: boolean;
  answerPresent: boolean;
  markerMatched: boolean;
  toolEvent: boolean;
  statusCode: number;
}

export function summarize(
  entry: Pick<Case, 'label' | 'marker'>,
  statusCode: number,
  payload: string,
): SafeResult {
  let reference: string | null = null;
  let code: string | null = null;
  let retryable: boolean | null = null;
  let synthetic = false;
  let done = false;
  let content = '';
  let toolEvent = false;
  const inspect = (event: unknown, eventName?: string): void => {
    if (typeof event !== 'object' || event === null) return;
    const record = event as Record<string, unknown>;
    if (typeof record.id === 'string' && record.id.length <= 128)
      reference ??= record.id;
    const meta = record.alia_meta;
    if (typeof meta === 'object' && meta !== null) {
      const fields = meta as Record<string, unknown>;
      synthetic ||= fields.synthetic === true;
      if (typeof fields.retryable === 'boolean') retryable = fields.retryable;
      const error = fields.error;
      if (typeof error === 'object' && error !== null) {
        const safe = error as Record<string, unknown>;
        if (typeof safe.code === 'string' && SAFE_CODES.has(safe.code))
          code ??= safe.code;
        if (typeof safe.reference === 'string' && safe.reference.length <= 128)
          reference ??= safe.reference;
      }
    }
    const error = record.error;
    if (typeof error === 'object' && error !== null) {
      const safe = error as Record<string, unknown>;
      if (typeof safe.code === 'string' && SAFE_CODES.has(safe.code))
        code ??= safe.code;
      else code ??= 'REQUEST_REFUSED';
    } else if (typeof error === 'string') code ??= 'REQUEST_REFUSED';
    const choices = record.choices;
    if (Array.isArray(choices)) {
      const delta = (choices[0] as { delta?: Record<string, unknown> } | undefined)
        ?.delta;
      if (typeof delta?.content === 'string') content += delta.content;
      if (Array.isArray(delta?.tool_calls)) {
        toolEvent ||= delta.tool_calls.some((call) => {
          if (typeof call !== 'object' || call === null) return false;
          const fn = (call as Record<string, unknown>).function;
          return (
            typeof fn === 'object' &&
            fn !== null &&
            (fn as Record<string, unknown>).name === 'webSearch'
          );
        });
      }
    }
    toolEvent ||=
      eventName === 'alia.tool_result' && record.name === 'webSearch';
  };
  if (!payload.includes('data: ')) inspect(JSON.parse(payload));
  let eventName: string | undefined;
  for (const line of payload.split(/\r?\n/)) {
    if (line.startsWith('event: ')) {
      eventName = line.slice(7);
      continue;
    }
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6);
    if (data === '[DONE]') {
      done = true;
      continue;
    }
    inspect(JSON.parse(data), eventName);
    eventName = undefined;
  }
  return {
    label: entry.label,
    reference,
    code,
    retryable,
    synthetic,
    done,
    answerPresent: content.length > 0,
    markerMatched: entry.marker === '' || content.includes(entry.marker),
    toolEvent,
    statusCode,
  };
}

async function waitUntilReady(signal: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const response = await fetch('http://127.0.0.1:3001/health/ready', {
      signal,
    }).catch(() => null);
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Alia API did not become ready');
}

async function main(): Promise<void> {
  const qaUserId = process.env.ALIA_CANARY_OXY_USER_ID;
  if (
    !qaUserId ||
    !/^(?:[a-f0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(
      qaUserId,
    )
  )
    throw new Error('ALIA_CANARY_OXY_USER_ID must name one exact QA account');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20 * 60 * 1_000);
  const api = spawn(process.execPath, ['packages/api/dist/index.js'], {
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  try {
    await waitUntilReady(controller.signal);
    const token = await oxyServiceToken();
    const results: SafeResult[] = [];
    for (const entry of PRODUCTION_CANARY_CASES) {
      const response = await fetch('http://127.0.0.1:3001/alia/chat', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token}`,
          'x-oxy-user-id': qaUserId,
          'content-type': 'application/json',
          'user-agent': 'alia-production-canary/1',
        },
        body: JSON.stringify({
          model: entry.model,
          messages: [{ role: 'user', content: entry.prompt }],
          stream: true,
          stream_options: { include_usage: true },
          ...(entry.deepResearch ? { deepResearch: true } : {}),
          ...(entry.tools ? { tools: entry.tools } : {}),
        }),
      });
      results.push(summarize(entry, response.status, await response.text()));
    }
    process.stdout.write(
      `ALIA_PRODUCTION_CANARY ${JSON.stringify({ schemaVersion: 1, conversationId: null, results })}\n`,
    );
    const ordinary = results.filter(
      (result) => result.label !== 'controlled-refusal',
    );
    const refusal = results.find(
      (result) => result.label === 'controlled-refusal',
    );
    const search = results.find((result) => result.label === 'search-tool');
    const references = ordinary.map((result) => result.reference);
    if (
      ordinary.some(
        (result) =>
          result.statusCode !== 200 ||
          result.synthetic ||
          !result.done ||
          !result.answerPresent ||
          !result.markerMatched ||
          !result.reference?.match(/^chatcmpl-[0-9a-f-]{36}$/),
      ) ||
      new Set(references).size !== ordinary.length ||
      !search?.toolEvent ||
      !refusal ||
      refusal.statusCode !== 400 ||
      refusal.code !== 'REQUEST_REFUSED' ||
      refusal.synthetic ||
      refusal.done ||
      refusal.answerPresent ||
      refusal.toolEvent ||
      results.at(-1)?.label !== 'recovery'
    )
      process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    api.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => api.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);
    if (api.exitCode === null) api.kill('SIGKILL');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();

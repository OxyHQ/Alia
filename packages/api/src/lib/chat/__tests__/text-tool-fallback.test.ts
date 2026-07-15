import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolSet } from 'ai';
import type { ToolInvocation } from '../stream-runner.js';

// ── Mock state ──────────────────────────────────────────────────────────────

const { mockStreamText } = vi.hoisted(() => ({
  mockStreamText: vi.fn(),
}));

vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => mockStreamText(...args),
}));

vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { v1: child, chat: child, general: child, providers: child } };
});

// streaming-helpers is real — it only calls res.write, which the mock captures.

import { runTextToolFallback } from '../text-tool-fallback.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockRes() {
  const written: string[] = [];
  return {
    write: vi.fn((data: string) => { written.push(data); return true; }),
    _written: written,
  };
}

/** A fullStream that yields a single text-delta (the model's follow-up reply). */
function followUpStream(text: string) {
  return {
    fullStream: (async function* () {
      yield { type: 'text-delta', text };
    })(),
  };
}

interface FallbackArgs {
  assistantResponse: string;
  toolInvocations: ToolInvocation[];
  execute: ReturnType<typeof vi.fn>;
  toolName?: string;
  res: ReturnType<typeof createMockRes>;
}

function runFallback({ assistantResponse, toolInvocations, execute, toolName = 'testTool', res }: FallbackArgs) {
  const tools = { [toolName]: { execute } } as unknown as ToolSet;
  return runTextToolFallback({
    assistantResponse,
    toolInvocations,
    tools,
    convertedMessages: [],
    baseConfig: {},
    res: res as never,
    requestId: 'chatcmpl-test',
    aliasModelId: 'alia-v1',
    resolved: { provider: 'openai', modelId: 'gpt-4o' },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('runTextToolFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStreamText.mockReturnValue(followUpStream('Follow-up reply'));
  });

  it('parses and executes the XML-ish <function(name)>{json}</function> format', async () => {
    const execute = vi.fn().mockResolvedValue('tool-output');
    const toolInvocations: ToolInvocation[] = [];
    const res = createMockRes();

    const result = await runFallback({
      assistantResponse: 'Intro <function(testTool)>{"foo":"bar"}</function> outro',
      toolInvocations,
      execute,
      res,
    });

    // Tool executed with the parsed JSON args
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ foo: 'bar' });

    // Invocation recorded with the tool output
    expect(toolInvocations).toHaveLength(1);
    expect(toolInvocations[0]).toMatchObject({ toolName: 'testTool', state: 'result', args: { foo: 'bar' }, result: 'tool-output' });

    // Follow-up completion drives the returned assistant text (tool markup stripped)
    expect(mockStreamText).toHaveBeenCalledTimes(1);
    expect(result.assistantResponse).toBe('Follow-up reply');

    // A tool_call chunk and a tool_result event were streamed to the client
    const allWrites = res._written.join('');
    expect(allWrites).toContain('"tool_calls"');
    expect(allWrites).toContain('alia.tool_result');
  });

  it('parses and executes a whole-response JSON tool call (OpenAI format)', async () => {
    const execute = vi.fn().mockResolvedValue('json-tool-output');
    const toolInvocations: ToolInvocation[] = [];
    const res = createMockRes();

    const result = await runFallback({
      assistantResponse: '{"type":"function","name":"testTool","parameters":{"x":1}}',
      toolInvocations,
      execute,
      res,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ x: 1 });
    expect(toolInvocations).toHaveLength(1);
    expect(toolInvocations[0]).toMatchObject({ toolName: 'testTool', state: 'result', result: 'json-tool-output' });

    // Format-2 clears the raw JSON from the assistant text after execution
    expect(result.assistantResponse).toBe('');
  });

  it('skips a text tool call that references an unknown tool', async () => {
    const execute = vi.fn().mockResolvedValue('unused');
    const toolInvocations: ToolInvocation[] = [];
    const res = createMockRes();

    const result = await runFallback({
      assistantResponse: '<function(missingTool)>{"a":1}</function>',
      toolInvocations,
      execute, // registered as `testTool`, so `missingTool` is unknown
      res,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(mockStreamText).not.toHaveBeenCalled();
    expect(toolInvocations).toHaveLength(0);
    // The unresolved markup is stripped from the assistant text
    expect(result.assistantResponse).toBe('');
  });

  it('skips a text tool call whose JSON args are malformed', async () => {
    const execute = vi.fn().mockResolvedValue('unused');
    const toolInvocations: ToolInvocation[] = [];
    const res = createMockRes();

    const result = await runFallback({
      assistantResponse: '<function(testTool)>{not valid json}</function>',
      toolInvocations,
      execute,
      res,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(mockStreamText).not.toHaveBeenCalled();
    expect(toolInvocations).toHaveLength(0);
    expect(result.assistantResponse).toBe('');
  });

  it('does nothing when native tool invocations already exist', async () => {
    const execute = vi.fn().mockResolvedValue('unused');
    const toolInvocations: ToolInvocation[] = [
      { toolCallId: 'native-1', toolName: 'testTool', state: 'result', result: 'x' },
    ];
    const res = createMockRes();

    const result = await runFallback({
      assistantResponse: '<function(testTool)>{"foo":"bar"}</function>',
      toolInvocations,
      execute,
      res,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(mockStreamText).not.toHaveBeenCalled();
    expect(toolInvocations).toHaveLength(1);
    // Untouched — the fallback only runs when no native tool calls were made
    expect(result.assistantResponse).toBe('<function(testTool)>{"foo":"bar"}</function>');
  });
});

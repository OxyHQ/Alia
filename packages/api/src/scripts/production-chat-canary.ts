import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import type { Request, Response } from "express";
import { handleChatCompletions } from "../routes/v1/chat-completions.js";
import { closePostgres, connectPostgres } from "../db/index.js";
import { oxyServiceToken } from "../lib/oxy-service-client.js";

type Case = Readonly<{
  label: string;
  model: string;
  prompt: string;
  deepResearch?: boolean;
  webSearch?: boolean;
  tools?: string[];
}>;
const CASES: readonly Case[] = [
  {
    label: "instant-1",
    model: "route:instant",
    prompt: "Reply exactly QA_INSTANT_OK_1.",
  },
  {
    label: "instant-2",
    model: "route:instant",
    prompt: "Reply exactly QA_INSTANT_OK_2.",
  },
  {
    label: "auto-1",
    model: "route:auto",
    prompt: "Reply exactly QA_AUTO_OK_1.",
  },
  {
    label: "auto-2",
    model: "route:auto",
    prompt: "Reply exactly QA_AUTO_OK_2.",
  },
  {
    label: "thinking-1",
    model: "route:thinking",
    prompt: "Calculate 17 + 25 and reply exactly QA_THINKING_OK_42.",
  },
  {
    label: "thinking-2",
    model: "route:thinking",
    prompt: "Calculate 19 + 24 and reply exactly QA_THINKING_OK_43.",
  },
  {
    label: "research-1",
    model: "route:research",
    prompt: "Name the capital of France in one sentence.",
    deepResearch: true,
  },
  {
    label: "research-2",
    model: "route:research",
    prompt: "Name the capital of Italy in one sentence.",
    deepResearch: true,
  },
  {
    label: "search-tool",
    model: "route:auto",
    prompt:
      "Use web search to find the official React documentation and explain React in two sentences with its official link.",
    webSearch: true,
    tools: ["webSearch", "webScraper"],
  },
  {
    label: "controlled-refusal",
    model: "route:not-registered",
    prompt: "This request must be refused safely.",
  },
  {
    label: "recovery",
    model: "route:auto",
    prompt: "Reply exactly QA_RECOVERY_OK without tools.",
  },
];

interface SafeResult {
  label: string;
  reference: string | null;
  code: string | null;
  retryable: boolean | null;
  synthetic: boolean;
  done: boolean;
  answerDelta: boolean;
  toolEvent: boolean;
  statusCode: number;
}

class CanaryResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  readonly frames: string[] = [];
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  setHeader(): this {
    this.headersSent = true;
    return this;
  }
  flushHeaders(): void {
    this.headersSent = true;
  }
  json(value: unknown): this {
    this.headersSent = true;
    this.frames.push(JSON.stringify(value));
    this.end();
    return this;
  }
  write(value: string | Uint8Array): boolean {
    this.headersSent = true;
    this.frames.push(String(value));
    return true;
  }
  end(value?: string | Uint8Array): this {
    if (value !== undefined) this.frames.push(String(value));
    this.writableEnded = true;
    this.emit("finish");
    return this;
  }
}

export function summarize(
  label: string,
  statusCode: number,
  payload: string,
): SafeResult {
  let reference: string | null = null;
  let code: string | null = null;
  let retryable: boolean | null = null;
  let synthetic = false;
  let done = false;
  let answerDelta = false;
  let toolEvent = false;
  if (!payload.includes("data: ")) {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed === "object" && parsed !== null) {
      const error = (parsed as Record<string, unknown>).error;
      if (typeof error === "object" && error !== null) {
        const safe = error as Record<string, unknown>;
        if (typeof safe.code === "string") code = safe.code;
        if (typeof safe.reference === "string") reference = safe.reference;
        if (typeof safe.retryable === "boolean") retryable = safe.retryable;
      } else if (typeof error === "string") code = "REQUEST_REFUSED";
    }
  }
  for (const line of payload.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    const event: unknown = JSON.parse(data);
    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;
    if (typeof record.id === "string") reference ??= record.id;
    const meta = record.alia_meta;
    if (typeof meta === "object" && meta !== null) {
      const safe = meta as Record<string, unknown>;
      synthetic ||= safe.synthetic === true;
      if (typeof safe.retryable === "boolean") retryable = safe.retryable;
      const error = safe.error;
      if (typeof error === "object" && error !== null) {
        const fields = error as Record<string, unknown>;
        if (typeof fields.code === "string") code ??= fields.code;
        if (typeof fields.reference === "string")
          reference ??= fields.reference;
      }
    }
    const choices = record.choices;
    if (Array.isArray(choices)) {
      const delta = (
        choices[0] as
          { delta?: { content?: unknown; tool_calls?: unknown } } | undefined
      )?.delta;
      answerDelta ||=
        typeof delta?.content === "string" && delta.content.length > 0;
      toolEvent ||= delta?.tool_calls !== undefined;
    }
    const kind = `${String(record.event ?? "")} ${String(record.type ?? "")}`;
    toolEvent ||= kind.includes("tool");
  }
  return {
    label,
    reference,
    code,
    retryable,
    synthetic,
    done,
    answerDelta,
    toolEvent,
    statusCode,
  };
}

async function run(
  entry: Case,
  qaUserId: string,
  serviceToken: string,
): Promise<SafeResult> {
  const req = Object.assign(new EventEmitter(), {
    body: {
      model: entry.model,
      messages: [{ role: "user", content: entry.prompt }],
      stream: true,
      stream_options: { include_usage: true },
      ...(entry.deepResearch ? { deepResearch: true } : {}),
      ...(entry.webSearch ? { webSearch: true } : {}),
      ...(entry.tools ? { tools: entry.tools } : {}),
    },
    headers: {},
    method: "POST",
    path: "/alia/chat",
    user: { id: qaUserId },
    userId: qaUserId,
    accessToken: serviceToken,
    socket: { destroyed: false, setNoDelay: () => undefined },
  }) as unknown as Request;
  const res = new CanaryResponse();
  await handleChatCompletions(req, res as unknown as Response);
  return summarize(entry.label, res.statusCode, res.frames.join(""));
}

async function main(): Promise<void> {
  const qaUserId = process.env.ALIA_CANARY_OXY_USER_ID;
  if (
    !qaUserId ||
    !/^(?:[a-f0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(
      qaUserId,
    )
  )
    throw new Error("ALIA_CANARY_OXY_USER_ID must name one exact QA account");
  if (!connectPostgres(process.env.DATABASE_URL))
    throw new Error("DATABASE_URL is required");
  try {
    const serviceToken = await oxyServiceToken();
    const results: SafeResult[] = [];
    for (const entry of CASES)
      results.push(await run(entry, qaUserId, serviceToken));
    process.stdout.write(
      `ALIA_PRODUCTION_CANARY ${JSON.stringify({ schemaVersion: 1, qaIdentity: qaUserId, conversationId: null, results })}\n`,
    );
    const ordinary = results.filter(
      (result) => result.label !== "controlled-refusal",
    );
    const refusal = results.find(
      (result) => result.label === "controlled-refusal",
    );
    if (
      ordinary.some(
        (result) =>
          result.statusCode !== 200 ||
          result.synthetic ||
          !result.done ||
          !result.answerDelta,
      ) ||
      !refusal ||
      refusal.code === null ||
      results.at(-1)?.label !== "recovery"
    )
      process.exitCode = 1;
  } finally {
    await closePostgres();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();

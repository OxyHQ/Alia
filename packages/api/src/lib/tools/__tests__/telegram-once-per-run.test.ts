import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A Redis with the one behaviour the claim relies on: SET ... NX is atomic and DEL removes. */
const marks = vi.hoisted(() => new Map<string, string>());
const redis = vi.hoisted(() => ({
  set: vi.fn(async (key: string, value: string, ..._args: unknown[]) => {
    if (marks.has(key)) return null;
    marks.set(key, value);
    return 'OK';
  }),
  del: vi.fn(async (key: string) => (marks.delete(key) ? 1 : 0)),
}));
const redisState = vi.hoisted(() => ({ available: true }));

vi.mock('../../redis.js', () => ({ getRedisClient: () => (redisState.available ? redis : null) }));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/integrations/botRepository.js', () => ({
  findSystemBot: vi.fn(async () => ({ id: 'bot-1' })),
  findLinkedBotUser: vi.fn(async () => ({ chatId: 'chat-1', platformUserId: 'p1' })),
}));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { tools: child } };
});

const { createSendTelegramTool } = await import('../telegram.js');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

type Exec = (input: { message: string }, options: never) => Promise<{ success: boolean }>;
const send = (tool: ReturnType<typeof createSendTelegramTool>, message: string) =>
  (tool.execute as unknown as Exec)({ message }, {} as never);

beforeEach(() => {
  marks.clear();
  vi.clearAllMocks();
  redisState.available = true;
  process.env.TELEGRAM_BOT_TOKEN = 'token';
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

describe('sendTelegramMessage inside a run', () => {
  it('sends a message once however many times the run is retried', async () => {
    const first = await send(createSendTelegramTool('u1', 'run-1'), 'Tu tarea terminó');
    // The queue retries the whole run: a new tool, the same run.
    const retry = await send(createSendTelegramTool('u1', 'run-1'), 'Tu tarea terminó');

    expect(first.success).toBe(true);
    expect(retry.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still sends a different message, and the same message in a different run', async () => {
    await send(createSendTelegramTool('u1', 'run-1'), 'uno');
    await send(createSendTelegramTool('u1', 'run-1'), 'dos');
    await send(createSendTelegramTool('u1', 'run-2'), 'uno');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('lets the retry send what failed the first time: a failed send releases its claim', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ description: 'Bad Gateway' }),
    });
    const failed = await send(createSendTelegramTool('u1', 'run-1'), 'aviso');
    expect(failed.success).toBe(false);

    const retried = await send(createSendTelegramTool('u1', 'run-1'), 'aviso');
    expect(retried.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('is not limited outside a run: a chat can send the same text twice', async () => {
    const tool = createSendTelegramTool('u1');
    await send(tool, 'hola');
    await send(tool, 'hola');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('sends when there is no Redis to claim against, and when Redis errors', async () => {
    redisState.available = false;
    await send(createSendTelegramTool('u1', 'run-1'), 'sin redis');
    redisState.available = true;
    redis.set.mockRejectedValueOnce(new Error('redis down'));
    await send(createSendTelegramTool('u1', 'run-1'), 'redis caído');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

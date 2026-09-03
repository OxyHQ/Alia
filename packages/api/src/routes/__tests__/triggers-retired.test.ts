import express from 'express';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (
    request: express.Request,
    _response: express.Response,
    next: express.NextFunction,
  ) => {
    request.user = { id: 'owner-1' };
    next();
  },
}));
vi.mock('../../db/automation/triggerRepository.js', () => ({
  countTriggerExecutions: vi.fn(async () => 0),
  findTriggerForUser: vi.fn(async () => null),
  listTriggerExecutions: vi.fn(async () => []),
  listTriggers: vi.fn(async () => []),
}));
vi.mock('../../lib/logger.js', () => ({
  log: { triggers: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const { default: router } = await import('../triggers.js');

let server: Server;
let port: number;

function send(method: string, path: string): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

beforeAll(async () => {
  const app = express();
  app.use('/triggers', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server has no TCP port');
  port = address.port;
});

afterAll(async () => new Promise<void>((resolve, reject) => (
  server.close((error) => error ? reject(error) : resolve())
)));

describe('retired trigger writes', () => {
  for (const [method, path] of [
    ['POST', '/triggers'],
    ['PATCH', '/triggers/trigger-1'],
    ['DELETE', '/triggers/trigger-1'],
    ['POST', '/triggers/trigger-1/run'],
    ['POST', '/triggers/trigger-1/regenerate-token'],
    ['POST', '/triggers/webhook/token-1'],
  ] as const) {
    it(`${method} ${path} fails closed`, async () => {
      const response = await send(method, path);
      expect(response).toEqual({
        status: 410,
        body: {
          error: 'legacy_trigger_write_retired',
          replacement: '/automations',
        },
      });
    });
  }

  it('keeps historical reads available', async () => {
    await expect(send('GET', '/triggers')).resolves.toEqual({
      status: 200,
      body: { triggers: [] },
    });
  });
});

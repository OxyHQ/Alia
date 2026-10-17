import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Oxy's file events (oxy ADR 0043 D9), through the real signature check of
 * `@oxy.so/core/server`: the challenge, the refusals, the dedupe, and what a
 * deleted or taken-down file does to the rows that use it. The SQL of those
 * writes is `db/__tests__/oxyFiles.pgdb.test.ts`.
 */

const H = vi.hoisted(() => ({
  handled: new Set<string>(),
  dropCover: vi.fn(async (_db: unknown, _fileId: string) => ['series-1']),
  deleteLibrary: vi.fn(async (_db: unknown, _fileId: string) => 1),
  deleteClips: vi.fn(async (_db: unknown, _fileId: string) => [
    { cacheKey: 'clip-1', objectKey: 'legacy/clip.mp3', oxyFileId: 'f' },
  ]),
  references: vi.fn(),
  garbage: vi.fn(),
}));

vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { log: { files: child, general: child } };
});
vi.mock('../../db/index.js', () => ({
  getDb: () => ({ transaction: async (work: (tx: unknown) => unknown) => work({}) }),
}));
vi.mock('../../db/files/oxyFileRepository.js', () => ({
  isFileEventHandled: async (_db: unknown, id: string) => H.handled.has(id),
  claimFileEvent: async (_db: unknown, event: { id: string }) => {
    H.handled.add(event.id);
    return true;
  },
  recordFileReferences: H.references,
  markLegacyObjectsMaybeGarbage: H.garbage,
}));
vi.mock('../../db/shows/showRepository.js', () => ({ dropSeriesCoverFile: H.dropCover }));
vi.mock('../../db/library/libraryFileRepository.js', () => ({
  deleteLibraryFilesByOxyFile: H.deleteLibrary,
}));
vi.mock('../../db/chat/speechClipRepository.js', () => ({
  deleteSpeechClipsByOxyFile: H.deleteClips,
}));

import oxyFilesWebhookRouter from '../oxy-files-webhook.js';

const SECRET = 'whsec_alia_test_secret';

function sign(body: string, secret = SECRET, at = Math.floor(Date.now() / 1000)): string {
  return `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`;
}

let server: Server;
let base: string;
let parsedServer: Server;
let parsedBase: string;

async function listen(app: express.Express): Promise<[Server, string]> {
  const listening: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return [listening, `http://127.0.0.1:${(listening.address() as AddressInfo).port}`];
}

beforeAll(async () => {
  const app = express();
  app.use('/webhooks/oxy-files', express.raw({ type: 'application/json' }), oxyFilesWebhookRouter);
  [server, base] = await listen(app);
  // The mistake the mount order exists to prevent: the JSON parser first.
  const parsed = express();
  parsed.use(express.json());
  parsed.use('/webhooks/oxy-files', oxyFilesWebhookRouter);
  [parsedServer, parsedBase] = await listen(parsed);
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => parsedServer.close(resolve));
});

beforeEach(() => {
  process.env.OXY_FILES_WEBHOOK_SECRET = SECRET;
  H.handled.clear();
  vi.clearAllMocks();
});

function event(type: string, references: { entityType: string; entityId: string }[]) {
  return JSON.stringify({
    id: `evt-${type}-${references.length}`,
    type,
    occurredAt: new Date().toISOString(),
    file: { id: 'f', ownerKind: 'application', visibility: 'public', status: 'deleted' },
    references,
  });
}

async function post(body: string, signature?: string, at = base) {
  return fetch(`${at}/webhooks/oxy-files`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature === undefined ? {} : { 'oxy-signature': signature }),
    },
    body,
  });
}

describe('the endpoint', () => {
  it('is not there without a secret', async () => {
    delete process.env.OXY_FILES_WEBHOOK_SECRET;
    const body = event('file.deleted', []);
    expect((await post(body, sign(body))).status).toBe(404);
    expect((await post(body)).status).toBe(404);
    expect((await post('not json')).status).toBe(404);
  });

  it('answers the registration challenge before it has a secret — registering is what issues one', async () => {
    delete process.env.OXY_FILES_WEBHOOK_SECRET;
    // Signed, as Oxy sends it, with the NEW secret Alia cannot know yet.
    const body = JSON.stringify({ type: 'webhook.challenge', challenge: 'c-0' });
    const response = await post(body, sign(body, 'whsec_issued_in_the_response'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: 'c-0' });
    expect(H.dropCover).not.toHaveBeenCalled();
  });

  it('echoes the verification challenge', async () => {
    const response = await post(JSON.stringify({ type: 'webhook.challenge', challenge: 'c-1' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: 'c-1' });
  });

  it('refuses a missing, wrong or stale signature', async () => {
    const body = event('file.deleted', [{ entityType: 'show_series', entityId: 's' }]);
    expect((await post(body)).status).toBe(401);
    expect((await post(body, sign(body, 'whsec_someone_else'))).status).toBe(401);
    expect(
      (await post(body, sign(body, SECRET, Math.floor(Date.now() / 1000) - 3600))).status,
    ).toBe(401);
    expect(H.dropCover).not.toHaveBeenCalled();
  });

  it('refuses a body some parser already consumed', async () => {
    const body = event('file.deleted', [{ entityType: 'show_series', entityId: 's' }]);
    expect((await post(body, sign(body), parsedBase)).status).toBe(500);
    expect(H.dropCover).not.toHaveBeenCalled();
  });

  it('is mounted above express.json() in the real app', () => {
    const source = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
    const mount = source.indexOf("'/webhooks/oxy-files'");
    // The parser itself, not a comment that names it.
    const parser = source.indexOf('app.use(\n  express.json(');
    expect(mount).toBeGreaterThan(-1);
    expect(parser).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(parser);
  });
});

describe('what an event does', () => {
  it('a deleted or blocked file lets go of every row of Alia that used it', async () => {
    const body = event('file.blocked', [
      { entityType: 'show_series', entityId: 's' },
      { entityType: 'library_file', entityId: 'l' },
      { entityType: 'speech_clip', entityId: 'clip-1' },
    ]);
    expect((await post(body, sign(body))).status).toBe(204);
    expect(H.dropCover).toHaveBeenCalledWith(expect.anything(), 'f');
    expect(H.deleteLibrary).toHaveBeenCalledWith(expect.anything(), 'f');
    expect(H.deleteClips).toHaveBeenCalledWith(expect.anything(), 'f');
    expect(H.references).toHaveBeenCalledWith(expect.anything(), [
      { fileId: 'f', entityType: 'speech_clip', entityId: 'clip-1', desired: 'absent' },
    ]);
    expect(H.garbage).toHaveBeenCalledWith(
      expect.anything(),
      [{ key: 'legacy/clip.mp3', kind: 'speech_clip' }],
      0,
    );
  });

  it('acts on a redelivery only once', async () => {
    const body = event('file.deleted', [{ entityType: 'show_series', entityId: 's' }]);
    expect((await post(body, sign(body))).status).toBe(204);
    expect((await post(body, sign(body))).status).toBe(204);
    expect(H.dropCover).toHaveBeenCalledTimes(1);
  });

  it('only records trash, restore and visibility changes', async () => {
    for (const type of [
      'file.trashed',
      'file.restored',
      'file.unblocked',
      'file.visibility_changed',
    ]) {
      const body = event(type, [{ entityType: 'show_series', entityId: 's' }]);
      expect((await post(body, sign(body))).status).toBe(204);
    }
    expect(H.dropCover).not.toHaveBeenCalled();
    expect(H.deleteLibrary).not.toHaveBeenCalled();
  });

  it('answers 500 when handling fails, so Oxy delivers it again', async () => {
    H.dropCover.mockRejectedValueOnce(new Error('connection lost'));
    const body = event('file.deleted', [{ entityType: 'show_series', entityId: 's' }]);
    expect((await post(body, sign(body))).status).toBe(500);
    expect((await post(body, sign(body))).status).toBe(204);
    expect(H.dropCover).toHaveBeenCalledTimes(2);
  });
});

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A series created without cover art has to leave something behind.
 *
 * Not blocking the series is the decision, and it stands — `cover-art.ts`
 * answers `null` rather than throwing on purpose. But "did not block" and "left
 * no trace" are different properties, and only the first one was implemented:
 * of the three ways `mintCover` answered `null`, two said nothing at all and
 * the third logged an error that named the owner and not the series. So the
 * only evidence that a production series had no artwork was a person looking at
 * the podcast and seeing a grey square.
 *
 * The subject here is therefore the trace, not the drawing — `cover-art.ts` is
 * mocked, and `lib/show/__tests__/cover-art.test.ts` owns the question of
 * whether an image provider can actually be reached.
 */

const USER_ID = 'user-under-test';
const PODCAST_ID = 'syra-podcast-1';
const NO_COVER = 'A show series was created without cover art';

/** What `generateCoverArt` answers this run. `null` is the production case. */
let drawnCover: Buffer | null = null;
/** Every `createPodcast` payload, so "the series was still created" is measured. */
let podcastsCreated: Record<string, unknown>[] = [];
let refunded = 0;
let finalized = 0;

vi.mock('../../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/auth.js')>(
    '../../middleware/auth.js',
  );
  return {
    ...actual,
    authenticateToken: (
      req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ) => {
      req.user = { id: USER_ID };
      next();
    },
  };
});

vi.mock('../../lib/show/cover-art.js', () => ({
  generateCoverArt: async () => drawnCover,
}));

/** Every cover stored in Oxy this run, so "drawn and stored as Alia's" is measured. */
let coversStored: { bytes: Uint8Array; mime: string }[] = [];
/** Every cover uploaded into Syra this run — the path until Syra takes Oxy files. */
let coversUploadedToSyra: { type: string; filename: string | undefined }[] = [];

vi.mock('../../lib/syra/syra.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/syra/syra.js')>('../../lib/syra/syra.js');
  return {
    ...actual,
    withSyraRequest: async (_req: unknown, operation: (client: unknown) => unknown) =>
      operation({
        createPodcast: async (payload: Record<string, unknown>) => {
          podcastsCreated.push(payload);
          return { id: PODCAST_ID };
        },
        uploadPodcastImage: async (image: Blob, filename?: string) => {
          coversUploadedToSyra.push({ type: image.type, filename });
          return { id: 'syra-image-1' };
        },
      }),
  };
});

vi.mock('../../lib/credits-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../lib/credits-manager.js')>(
    '../../lib/credits-manager.js',
  );
  return {
    ...actual,
    reserveCredits: async () => ({ reservationId: 'res-1', userId: USER_ID, amount: 5 }),
    refundReservation: async () => {
      refunded += 1;
    },
    finalizeFixedCredits: async () => {
      finalized += 1;
    },
  };
});

vi.mock('../../lib/user-credits-helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../../lib/user-credits-helpers.js')>(
    '../../lib/user-credits-helpers.js',
  );
  return { ...actual, getOrCreateUserCredits: async () => ({ userId: USER_ID }) };
});

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js');
  return { ...actual, getDb: () => ({}) };
});

vi.mock('../../db/shows/showRepository.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/shows/showRepository.js')>(
    '../../db/shows/showRepository.js',
  );
  return {
    ...actual,
    findPreferences: async () => null,
    // Echoes what the route decided, so the response carries the id the trace
    // has to match.
    createSeries: async (_db: unknown, values: Record<string, unknown>) => values,
  };
});

import type { OxyServer } from '@oxy.so/core/server';
import showsRouter from '../shows.js';
import { log } from '../../lib/logger.js';
import { setOxyFilesClientForTests, sha256Hex } from '../../lib/files/oxy-files.js';

/** Alia's Oxy service client, as far as storing a cover goes. */
const fakeOxy = {
  assets: {
    uploadAppFile: async (bytes: Uint8Array, mime: string) => {
      coversStored.push({ bytes, mime });
      return { file: { id: 'oxy-cover-1', sha256: sha256Hex(bytes) } };
    },
  },
} as unknown as OxyServer;

let server: Server;
let base: string;
let warned: { fields: Record<string, unknown>; message: string }[] = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/shows', showsRouter);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setOxyFilesClientForTests(() => fakeOxy);
});

afterAll(async () => {
  setOxyFilesClientForTests(null);
  await await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  drawnCover = null;
  podcastsCreated = [];
  coversStored = [];
  coversUploadedToSyra = [];
  warned = [];
  refunded = 0;
  finalized = 0;
  vi.spyOn(log.general, 'warn').mockImplementation(((fields: unknown, message?: string) => {
    warned.push({
      fields: (typeof fields === 'object' && fields !== null ? fields : {}) as Record<
        string,
        unknown
      >,
      message: message ?? String(fields),
    });
    return undefined;
  }) as typeof log.general.warn);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function createSeries(): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/shows/series`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Cocina de Barrio', brief: 'Recetas de la abuela' }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('a series created without a cover', () => {
  it('is still created, and says so once, naming the series', async () => {
    const { status, body } = await createSeries();

    // The decision that stands: no artwork does not cost anybody their series.
    expect(status).toBe(201);
    expect(podcastsCreated).toHaveLength(1);
    expect(podcastsCreated[0]).not.toHaveProperty('image');
    expect(podcastsCreated[0]).not.toHaveProperty('imageFileId');
    expect(body.coverFileId).toBeUndefined();
    expect(coversStored).toEqual([]);
    expect(coversUploadedToSyra).toEqual([]);

    // The property that was missing. One message, so a single search over the
    // logs answers "which series have no artwork, and why".
    const traces = warned.filter((entry) => entry.message === NO_COVER);
    expect(traces).toHaveLength(1);
    expect(traces[0]?.fields.reason).toBe('no_image_generated');
    expect(traces[0]?.fields.userId).toBe(USER_ID);
    // The series id, and the one the caller was actually given — a trace that
    // named a different series would be worse than none.
    expect(traces[0]?.fields.seriesId).toBe(body.id);
    expect(typeof body.id).toBe('string');

    // And the credit came back, since nothing was drawn.
    expect(refunded).toBe(1);
    expect(finalized).toBe(0);
  });

  it('says nothing when the cover was drawn, and uploads it into Syra until Syra takes files', async () => {
    // The positive control. Without it, a logger that emitted this line on
    // every request would satisfy the assertions above.
    drawnCover = Buffer.from('a-generated-cover', 'utf8');

    const { status, body } = await createSeries();

    expect(status).toBe(201);
    expect(warned.filter((entry) => entry.message === NO_COVER)).toEqual([]);
    // The default: a Syra that does not know `imageFileId` would drop it, so
    // the cover goes into Syra as before and Alia holds no file for it.
    expect(coversStored).toEqual([]);
    expect(coversUploadedToSyra).toEqual([{ type: 'image/png', filename: 'cover.png' }]);
    expect(podcastsCreated[0]?.image).toBe('syra-image-1');
    expect(podcastsCreated[0]).not.toHaveProperty('imageFileId');
    expect(body.coverImageAssetId).toBe('syra-image-1');
    expect(body.coverFileId).toBeUndefined();
    expect(finalized).toBe(1);
    expect(refunded).toBe(0);
  });

  it("stores the drawn cover as Alia's Oxy file once Syra takes files", async () => {
    vi.stubEnv('SYRA_COVER_FILE_IDS', 'enabled');
    drawnCover = Buffer.from('a-generated-cover', 'utf8');

    const { status, body } = await createSeries();

    expect(status).toBe(201);
    expect(warned.filter((entry) => entry.message === NO_COVER)).toEqual([]);
    // Stored as ALIA's file, and Syra is handed the file id — not an upload.
    expect(coversStored).toEqual([{ bytes: drawnCover, mime: 'image/png' }]);
    expect(coversUploadedToSyra).toEqual([]);
    expect(podcastsCreated[0]?.imageFileId).toBe('oxy-cover-1');
    expect(podcastsCreated[0]).not.toHaveProperty('image');
    expect(body.coverFileId).toBe('oxy-cover-1');
    expect(body.coverImageAssetId).toBeUndefined();
    expect(finalized).toBe(1);
    expect(refunded).toBe(0);
  });
});

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyraApiError } from '@syra.fm/sdk';

/**
 * Deleting a show, and deleting it in BOTH places.
 *
 * This file exists because of a bug that shipped and that a user found: they
 * deleted a series in Alia, and the podcast stayed in Syra with seven episodes,
 * owned by an Alia series id that no longer existed. No surface in either
 * product could then remove it. "Sólo hay un sitio de la verdad" is the
 * requirement that came out of it.
 *
 * ## What a "it returns 200" test would not catch, and this one does
 *
 * **The ORDER.** Deleting Alia's row first and Syra's second produces exactly
 * the orphan above whenever the second half fails — and it produces a green
 * test either way, because both orders end with a 200 on the happy path. So
 * every call is recorded into one sequence and the assertion is on the
 * sequence, not on the outcome.
 *
 * **That a refusal leaves BOTH standing.** The tempting shape is to delete
 * locally anyway and log the Syra failure, which is indistinguishable from
 * success at the response and reintroduces the bug on the exact path the fix
 * was written for.
 *
 * **That `404` is NOT a refusal.** The row is gone, which is the state the
 * caller asked for. Treating it as a failure strands the pair the other way
 * round: Alia keeps a record of a podcast that no longer exists.
 */

const USER_ID = 'show-deleter';
const SERIES_ID = 'series-under-test';
const EPISODE_ID = 'episode-under-test';

/** Every side effect, in the order it happened. The order IS the assertion. */
let sequence: string[] = [];
/** What Syra should do when asked to delete. */
let syraOutcome: 'ok' | SyraApiError = 'ok';
/** Set to null to model a series that never reached Syra. */
let syraPodcastId: string | null = 'syra-podcast-1';
let syraEpisodeId: string | null = 'syra-episode-1';

vi.mock('../../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/auth.js')>(
    '../../middleware/auth.js',
  );
  return {
    ...actual,
    authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { id: USER_ID };
      next();
    },
  };
});

vi.mock('../../lib/syra/syra.js', async () => {
  const actual = await vi.importActual<typeof import('../../lib/syra/syra.js')>('../../lib/syra/syra.js');
  const remove = (what: string) => async (id: string) => {
    sequence.push(`syra:${what}:${id}`);
    if (syraOutcome !== 'ok') throw syraOutcome;
    return { id, episodesDeleted: 2, objectsDeleted: 5, podcastId: 'syra-podcast-1' };
  };
  return {
    ...actual,
    syraForRequest: () => ({
      deletePodcast: remove('deletePodcast'),
      deleteEpisode: remove('deleteEpisode'),
    }),
  };
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
    findSeriesForUser: async () => ({
      id: SERIES_ID,
      userId: USER_ID,
      syraPodcastId,
      title: 'The Wednesday Digest',
      brief: 'A weekly look at whatever the owner has been reading.',
      format: 'podcast',
      speakers: [],
      visibility: 'private',
      nextEpisodeNumber: 4,
    }),
    findEpisodeForUser: async () => ({
      id: EPISODE_ID,
      userId: USER_ID,
      seriesId: SERIES_ID,
      episodeNumber: 3,
      syraEpisodeId,
      status: 'completed',
    }),
    deleteSeriesForUser: async () => {
      sequence.push('alia:deleteSeries');
      return true;
    },
    deleteEpisodeForUser: async () => {
      sequence.push('alia:deleteEpisode');
      return true;
    },
  };
});

import showsRouter from '../shows.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/shows', showsRouter);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(
  async () =>
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
);

beforeEach(() => {
  sequence = [];
  syraOutcome = 'ok';
  syraPodcastId = 'syra-podcast-1';
  syraEpisodeId = 'syra-episode-1';
});

const del = (path: string) => fetch(`${base}${path}`, { method: 'DELETE' });

describe('deleting a series', () => {
  it('deletes on Syra BEFORE it deletes here', async () => {
    const response = await del(`/shows/series/${SERIES_ID}`);

    expect(response.status).toBe(200);
    // The order, not the outcome. Both orders answer 200 on this path.
    expect(sequence).toEqual(['syra:deletePodcast:syra-podcast-1', 'alia:deleteSeries']);
    expect(await response.json()).toMatchObject({ deleted: true, syraPodcastDeleted: true });
  });

  it('keeps BOTH records when Syra refuses', async () => {
    syraOutcome = new SyraApiError(403, 'Syra API request failed: 403 Forbidden');

    const response = await del(`/shows/series/${SERIES_ID}`);

    expect(response.status).toBe(502);
    // Alia's row survives. Deleting it anyway is the bug this file exists for.
    expect(sequence).toEqual(['syra:deletePodcast:syra-podcast-1']);
  });

  it('keeps BOTH records when the show is under a takedown', async () => {
    syraOutcome = new SyraApiError(409, 'Syra API request failed: 409 Conflict');

    expect((await del(`/shows/series/${SERIES_ID}`)).status).toBe(502);
    expect(sequence).toEqual(['syra:deletePodcast:syra-podcast-1']);
  });

  it('treats a podcast that is already gone as success', async () => {
    syraOutcome = new SyraApiError(404, 'Syra API request failed: 404 Not Found');

    const response = await del(`/shows/series/${SERIES_ID}`);

    // The state the caller asked for is the state that exists. Refusing here
    // would strand the pair the other way round: Alia keeping a record of a
    // podcast that is not there.
    expect(response.status).toBe(200);
    expect(sequence).toEqual(['syra:deletePodcast:syra-podcast-1', 'alia:deleteSeries']);
  });

  it('skips Syra entirely for a series that never reached it', async () => {
    syraPodcastId = null;

    const response = await del(`/shows/series/${SERIES_ID}`);

    expect(response.status).toBe(200);
    expect(sequence).toEqual(['alia:deleteSeries']);
    expect(await response.json()).toMatchObject({ syraPodcastDeleted: false });
  });
});

describe('deleting one episode', () => {
  it('deletes on Syra BEFORE it deletes here', async () => {
    const response = await del(`/shows/episodes/${EPISODE_ID}`);

    expect(response.status).toBe(200);
    expect(sequence).toEqual(['syra:deleteEpisode:syra-episode-1', 'alia:deleteEpisode']);
    expect(await response.json()).toMatchObject({ deleted: true, syraEpisodeDeleted: true });
  });

  it('keeps BOTH records when Syra refuses', async () => {
    syraOutcome = new SyraApiError(403, 'Syra API request failed: 403 Forbidden');

    expect((await del(`/shows/episodes/${EPISODE_ID}`)).status).toBe(502);
    expect(sequence).toEqual(['syra:deleteEpisode:syra-episode-1']);
  });

  it('treats an episode that is already gone as success', async () => {
    syraOutcome = new SyraApiError(404, 'Syra API request failed: 404 Not Found');

    expect((await del(`/shows/episodes/${EPISODE_ID}`)).status).toBe(200);
    expect(sequence).toEqual(['syra:deleteEpisode:syra-episode-1', 'alia:deleteEpisode']);
  });

  it('skips Syra for an episode that never reached it', async () => {
    syraEpisodeId = null;

    const response = await del(`/shows/episodes/${EPISODE_ID}`);

    expect(response.status).toBe(200);
    expect(sequence).toEqual(['alia:deleteEpisode']);
    expect(await response.json()).toMatchObject({ syraEpisodeDeleted: false });
  });
});

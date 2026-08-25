import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Asking for another episode is a request with nothing in it.
 *
 * The series' `brief` says what the show is about and the earlier episodes'
 * subjects say what it has already used, so a person pressing "new episode" has
 * nothing left to answer. This file is about the half of that which lives in the
 * route: it must accept a request with NO BODY AT ALL, insert a row with no
 * subject, and reserve the Syra draft under a placeholder name.
 *
 * ## The two things asserted here that a "it returns 201" test would not catch
 *
 * The name the draft is reserved with must be a PLACEHOLDER — `Episode {n}` —
 * and not a name invented from the request. The old route asked a model to turn
 * the caller's topic into a title before a word of the episode existed, so
 * "a title exists" was true under both designs and proves nothing. What
 * distinguishes them is that this route now makes no model call at all, which
 * is asserted directly.
 *
 * The pipeline half — that the published name comes off the finished script —
 * is `lib/show/__tests__/show-pipeline.pgdb.test.ts`'s, because it is a claim
 * about what reaches Syra.
 */

const USER_ID = 'episode-requester';
const SERIES_ID = 'series-under-test';

/** Every `createEpisodeDraft` call, so the reserved name is measurable. */
let drafts: { podcastId: string; input: Record<string, unknown> }[] = [];
/** Every row `createEpisode` was asked to insert. */
let inserted: Record<string, unknown>[] = [];
/** Every model call made while serving the request. Must stay empty. */
const generateText = vi.fn(async () => ({ text: 'a model was called' }));

vi.mock('ai', () => ({ generateText }));

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
  return {
    ...actual,
    syraForRequest: () => ({
      createEpisodeDraft: async (podcastId: string, input: Record<string, unknown>) => {
        drafts.push({ podcastId, input });
        return {
          episodeId: 'syra-episode-1',
          ingestTicket: 'ticket-1',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        };
      },
    }),
  };
});

vi.mock('../../lib/show/show-queue.js', () => ({
  enqueueShowGeneration: async () => ({ queued: true, jobId: 'job-1' }),
}));

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
      syraPodcastId: 'syra-podcast-1',
      title: 'The Wednesday Digest',
      brief: 'A weekly look at whatever the owner has been reading.',
      format: 'podcast',
      speakers: [],
      visibility: 'private',
      nextEpisodeNumber: 4,
    }),
    countActiveEpisodes: async () => 0,
    allocateEpisodeNumber: async () => 3,
    createEpisode: async (_db: unknown, values: Record<string, unknown>) => {
      inserted.push(values);
      return { id: 'episode-1', status: 'queued', ...values };
    },
    updateEpisode: async () => null,
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
  drafts = [];
  inserted = [];
  generateText.mockClear();
});

async function ask(init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/shows/series/${SERIES_ID}/episodes`, {
    method: 'POST',
    ...init,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('asking for another episode', () => {
  it('is accepted with no body at all', async () => {
    // Not `{}` — literally no body and no content type, which is what a client
    // sends when the request has nothing to say. Express leaves `req.body`
    // `undefined` for it, and a schema parsed straight off that answers 400.
    const { status, body } = await ask();

    expect(status).toBe(201);
    expect(body.episodeNumber).toBe(3);
    expect(inserted).toHaveLength(1);
    // No subject. The script chooses it from the brief and from what earlier
    // episodes covered, minutes from now.
    expect(inserted[0]?.topic).toBeUndefined();
  });

  it('is accepted with an empty JSON body, which is the same request', async () => {
    const { status } = await ask({
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(status).toBe(201);
    expect(inserted[0]?.topic).toBeUndefined();
  });

  it('reserves the Syra draft under a PLACEHOLDER name, and calls no model to get one', async () => {
    const { status, body } = await ask();

    expect(status).toBe(201);
    /**
     * `Episode 3` — the one thing that is certainly true minutes before the
     * episode exists. The route used to ask a model for a title here, from a
     * topic the caller had to type; a test asserting only that a title exists
     * would pass under that design too.
     */
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.input.title).toBe('Episode 3');
    expect(inserted[0]?.title).toBe('Episode 3');
    // Echoed, so the app can render the queued row rather than a blank one.
    expect(body.title).toBe('Episode 3');

    // The assertion that makes the ones above mean something: nothing on this
    // path asks a model anything. Reintroducing a naming call here fails this
    // even if it happened to produce the same string.
    expect(generateText).not.toHaveBeenCalled();
  });

  it('takes the owner\'s own words when they steer this one', async () => {
    // The positive control. A route that discarded its whole body would pass
    // every assertion above.
    const { status } = await ask({
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'the election result, and what it changes' }),
    });

    expect(status).toBe(201);
    expect(inserted[0]?.topic).toBe('the election result, and what it changes');
    // Still a placeholder name: a subject is not a title, which is why the
    // route stopped turning one into the other.
    expect(drafts[0]?.input.title).toBe('Episode 3');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('refuses a steer too short to be a subject, rather than silently dropping it', async () => {
    const { status, body } = await ask({
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'abc' }),
    });

    expect(status).toBe(400);
    expect(String((body.error as { message?: string })?.message)).toContain('at least 5');
    expect(inserted).toHaveLength(0);
    expect(drafts).toHaveLength(0);
  });

  it('refuses a title, because an episode is named from its script', async () => {
    // The field is GONE rather than ignored. Zod strips an unknown key by
    // default, so this asserts what the row got: a caller who still sends the
    // old field does not get to name the episode.
    const { status } = await ask({
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'A name I typed', topic: 'something worth covering' }),
    });

    expect(status).toBe(201);
    expect(drafts[0]?.input.title).toBe('Episode 3');
    expect(inserted[0]?.title).toBe('Episode 3');
  });
});

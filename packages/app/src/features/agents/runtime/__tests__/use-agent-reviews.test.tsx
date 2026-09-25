import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An agent's reviews, since they stopped being four `useState`s in the page.
 *
 * The routes are doubled with a tiny in-memory server that answers the way
 * `/agents/:id/reviews` does, and what is checked is what a reader of the
 * caches ends up holding: the list, the caller's own review, and the rating on
 * the agent itself.
 */

const server = vi.hoisted(() => ({
  reviews: [] as { _id: string; rating: number; comment: string; userId: { _id: string } }[],
  gets: 0,
}));

vi.mock('@/shared/api/client', () => ({
  default: {
    get: vi.fn(async () => {
      server.gets += 1;
      const mine = server.reviews.find((review) => review.userId._id === 'me') ?? null;
      return { data: { reviews: server.reviews, total: server.reviews.length, userReview: mine } };
    }),
    post: vi.fn(async (_url: string, body: { rating: number; comment: string }) => {
      const review = { _id: 'r-me', ...body, userId: { _id: 'me' } };
      server.reviews = [review, ...server.reviews.filter((r) => r.userId._id !== 'me')];
      return { data: { review, rating: body.rating, reviewCount: server.reviews.length } };
    }),
    delete: vi.fn(async () => {
      server.reviews = server.reviews.filter((r) => r.userId._id !== 'me');
      return { data: { deleted: true } };
    }),
    patch: vi.fn(),
  },
}));

const {
  useAgentReviewDraft,
  useAgentReviews,
  useDeleteAgentReview,
  useSubmitAgentReview,
} = await import('../use-agent-reviews');
const { queryKeys } = await import('@/shared/api/query-keys');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function useHarness() {
  const reviews = useAgentReviews('agent-1');
  return {
    reviews,
    draft: useAgentReviewDraft(reviews.data?.userReview),
    submit: useSubmitAgentReview('agent-1'),
    remove: useDeleteAgentReview('agent-1'),
  };
}

async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(queryKeys.agents.detail('agent-1'), {
    _id: 'agent-1',
    rating: 0,
    reviewCount: 0,
  });
  let latest: ReturnType<typeof useHarness> | undefined;
  function Probe() {
    latest = useHarness();
    return null;
  }
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  await settle();
  return { client, read: () => latest as ReturnType<typeof useHarness> };
}

beforeEach(() => {
  server.reviews = [];
  server.gets = 0;
});
afterEach(() => {
  if (renderer !== null) act(() => renderer?.unmount());
  renderer = null;
});

describe('the review draft', () => {
  it('opens on the caller’s existing review', async () => {
    server.reviews = [{ _id: 'r-me', rating: 4, comment: 'solid', userId: { _id: 'me' } }];
    const { read } = await mount();
    expect(read().draft.rating).toBe(4);
    expect(read().draft.comment).toBe('solid');
  });

  it('is not overwritten by a later answer while somebody edits', async () => {
    server.reviews = [{ _id: 'r-me', rating: 4, comment: 'solid', userId: { _id: 'me' } }];
    const { client, read } = await mount();
    await act(async () => {
      read().draft.setComment('changing my mind');
    });
    server.reviews = [{ _id: 'r-me', rating: 2, comment: 'from elsewhere', userId: { _id: 'me' } }];
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.agents.reviews('agent-1') });
    });
    await settle();
    expect(read().reviews.data?.userReview?.comment).toBe('from elsewhere');
    expect(read().draft.comment).toBe('changing my mind');
    expect(read().draft.rating).toBe(4);
  });
});

describe('writing a review', () => {
  it('lands in the list, as the caller’s own, and on the agent’s rating', async () => {
    const { client, read } = await mount();
    const before = server.gets;
    await act(async () => {
      await read().submit.mutateAsync({ rating: 5, comment: 'great' });
    });
    await settle();

    expect(read().reviews.data?.userReview?.rating).toBe(5);
    expect(read().reviews.data?.reviews.map((review) => review._id)).toEqual(['r-me']);
    expect(server.gets, 'the list is asked for again').toBeGreaterThan(before);
    expect(client.getQueryData(queryKeys.agents.detail('agent-1'))).toMatchObject({
      rating: 5,
      reviewCount: 1,
    });
  });
});

describe('deleting a review', () => {
  it('leaves no review of the caller’s, and no row for it in the list', async () => {
    server.reviews = [
      { _id: 'r-me', rating: 3, comment: 'ok', userId: { _id: 'me' } },
      { _id: 'r-other', rating: 5, comment: 'love it', userId: { _id: 'other' } },
    ];
    const { read } = await mount();
    await act(async () => {
      await read().remove.mutateAsync();
    });
    await settle();

    expect(read().reviews.data?.userReview).toBeNull();
    expect(read().reviews.data?.reviews.map((review) => review._id)).toEqual(['r-other']);
  });
});

import apiClient from '@/lib/api/client';
import { API_ROUTES } from '@/lib/api/routes';
import { queryKeys } from '@/lib/hooks/query-keys';
import type { Agent } from '@/lib/types/agents';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

/** A review, as the agent screen reads it off `GET /agents/:id/reviews`. */
export interface AgentReview {
  _id: string;
  rating: number;
  comment?: string | null;
  userId?: { _id?: string; username?: string } | null;
}

export interface AgentReviews {
  reviews: AgentReview[];
  /** The caller's own review of this agent, if they wrote one. */
  userReview: AgentReview | null;
}

/**
 * One agent's reviews, and the caller's own among them.
 *
 * A failure leaves the section empty rather than erroring the screen: the
 * reviews are a footnote to the agent, not a condition for showing it.
 */
export function useAgentReviews(agentId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.agents.reviews(agentId ?? ''),
    queryFn: async (): Promise<AgentReviews> => {
      const response = await apiClient.get(
        API_ROUTES.agents.reviews(agentId ?? ''),
      );
      return {
        reviews: response.data?.reviews || [],
        userReview: response.data?.userReview || null,
      };
    },
    enabled: typeof agentId === 'string' && agentId.length > 0,
  });
}

/**
 * Write (or rewrite) the caller's review.
 *
 * The rating and count the write changed come back in its answer and go
 * straight into the agent's cached record; the list is then asked for again
 * so the new review appears in it.
 */
export function useSubmitAgentReview(agentId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { rating: number; comment: string }) => {
      const response = await apiClient.post(
        API_ROUTES.agents.reviews(agentId),
        input,
      );
      return response.data as {
        review: AgentReview;
        rating: number;
        reviewCount: number;
      };
    },
    onSuccess: ({ review, rating, reviewCount }) => {
      queryClient.setQueryData<AgentReviews>(
        queryKeys.agents.reviews(agentId),
        (previous) => ({ reviews: previous?.reviews ?? [], userReview: review }),
      );
      queryClient.setQueryData<Agent>(
        queryKeys.agents.detail(agentId),
        (previous) =>
          previous === undefined ? previous : { ...previous, rating, reviewCount },
      );
      // Not awaited: the write is done, and saying so should not wait on a
      // list refresh.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.reviews(agentId),
      });
    },
  });
}

/**
 * Delete the caller's review. The rating the deletion changed comes back from
 * the server rather than being recomputed here.
 */
export function useDeleteAgentReview(agentId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      await apiClient.delete(API_ROUTES.agents.reviews(agentId));
    },
    onSuccess: () => {
      queryClient.setQueryData<AgentReviews>(
        queryKeys.agents.reviews(agentId),
        (previous) => ({ reviews: previous?.reviews ?? [], userReview: null }),
      );
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.detail(agentId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.reviews(agentId),
        }),
      ]);
    },
  });
}

/**
 * The review form's draft: a rating and a comment.
 *
 * Seeded ONCE from the caller's existing review, the first time the server
 * reports one, so reopening the form shows what they wrote. Never re-seeded
 * after that — a refetch landing while somebody edits must not overwrite what
 * they typed.
 */
export function useAgentReviewDraft(userReview: AgentReview | null | undefined) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current || !userReview) return;
    seeded.current = true;
    setRating(userReview.rating);
    setComment(userReview.comment || '');
  }, [userReview]);

  const reset = () => {
    setRating(0);
    setComment('');
  };

  return { rating, setRating, comment, setComment, reset };
}

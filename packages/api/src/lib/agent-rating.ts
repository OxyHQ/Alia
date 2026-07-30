import mongoose from 'mongoose';
import { Agent } from '../models/agent.js';
import { AgentReview } from '../models/agent-review.js';

/**
 * The one definition of an agent's rating.
 *
 * Three call sites recompute it — writing a review, deleting one, and hiding or
 * restoring one through a moderation decision — and the aggregate has to agree
 * across all three. It was inlined twice before the third arrived; a fourth copy
 * is how `hiddenByModeration` ends up honoured on one path and ignored on
 * another, which would show up only as a rating that quietly disagrees with the
 * reviews on screen.
 */

/** Reviews the public listing shows, which are the ones the rating counts. */
export const VISIBLE_REVIEW_MATCH = { hiddenByModeration: { $ne: true } } as const;

interface RatingStats {
  avg: number;
  count: number;
}

/**
 * Recalculate and persist `rating` and `reviewCount` from the visible reviews.
 *
 * Returns the new figures, or `null` when the agent no longer exists — a caller
 * removing a review for an agent that was deleted underneath it is ordinary, not
 * an error.
 */
export async function recalculateAgentRating(
  agentId: mongoose.Types.ObjectId | string,
): Promise<RatingStats | null> {
  const agent = await Agent.findById(agentId);
  if (!agent) return null;

  const stats = await AgentReview.aggregate<RatingStats>([
    { $match: { agentId: agent._id, ...VISIBLE_REVIEW_MATCH } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);

  const [computed] = stats;
  agent.rating = computed ? Math.round(computed.avg * 10) / 10 : 0;
  agent.reviewCount = computed ? computed.count : 0;
  await agent.save();

  return { avg: agent.rating, count: agent.reviewCount };
}

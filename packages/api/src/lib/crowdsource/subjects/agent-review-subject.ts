import mongoose from 'mongoose';
import { CONTRACT_LIMITS } from '@oxyhq/crowdsource-contracts';
import { Agent } from '../../../models/agent.js';
import { AgentReview } from '../../../models/agent-review.js';
import { ReportedType } from '../../../value-sets/report.js';
import type {
  ModerationContextResource,
  ModerationResource,
  ModerationSubjectProvider,
  ModerationSubjectSnapshot,
} from './types.js';

/**
 * A user's written review of an agent (§5.4 `commerce.review`).
 *
 * The only Alia subject that is a standard type rather than a `custom.alia.*` one,
 * and it earns it: this is a person's public opinion about a thing somebody else
 * published, which is exactly what `commerce.review` means everywhere else in the
 * taxonomy. Reporting it does not need a private vocabulary.
 *
 * ## Why the agent travels as context
 *
 * A review cannot be judged alone. "This is garbage and the author is a fraud" is
 * a harassment report or a fair review depending entirely on what it is reviewing,
 * and a jury given only the comment would be guessing. So the agent's own listing
 * travels with role `context` — its name and tagline, nothing more. Not its system
 * prompt: the question is whether the REVIEW crossed a line, and the agent's
 * instructions are not evidence for that.
 *
 * ## A review with no words
 *
 * A rating with an empty comment is normal — `comment` defaults to `''` — and the
 * contract's text resource requires at least one character, correctly. Such a
 * review gets a `metadata` resource (§5.3 "typed key value fields") saying what it
 * consisted of, rather than an empty text resource or an invented one. It is
 * almost never worth reporting, but a report about one must describe it honestly
 * instead of failing to deliver.
 */

const WEB_ORIGIN = process.env.WEB_URL || 'https://alia.onl';

interface SnapshotReview {
  _id: mongoose.Types.ObjectId;
  agentId?: mongoose.Types.ObjectId;
  userId?: mongoose.Types.ObjectId;
  rating?: number;
  comment?: string;
  createdAt?: Date;
}

interface ReviewedAgent {
  _id: mongoose.Types.ObjectId;
  name?: string;
  tagline?: string;
}

/** The agent being reviewed, as the minimum a jury needs to read the review. */
async function agentContext(
  agentId: mongoose.Types.ObjectId | undefined,
): Promise<ModerationContextResource | null> {
  if (agentId === undefined) return null;
  const agent = await Agent.findById(agentId)
    .select('name tagline')
    .lean<ReviewedAgent | null>();
  if (!agent) return null;

  const name = agent.name?.trim();
  const tagline = agent.tagline?.trim();
  const text = [name, tagline].filter((part): part is string => Boolean(part)).join(' — ');
  if (!text) return null;

  return {
    role: 'context',
    type: 'text',
    data: { text: text.slice(0, CONTRACT_LIMITS.TEXT_RESOURCE_MAX_LENGTH) },
  };
}

export function createAgentReviewSubjectProvider(): ModerationSubjectProvider {
  return {
    reportedType: ReportedType.AGENT_REVIEW,
    subjectType: 'commerce.review',

    async snapshot(reportedId: string): Promise<ModerationSubjectSnapshot | null> {
      if (!mongoose.isValidObjectId(reportedId)) return null;
      const review = await AgentReview.findById(reportedId)
        .select('agentId userId rating comment createdAt')
        .lean<SnapshotReview | null>();
      if (!review) return null;

      const comment = review.comment?.trim();
      const content: ModerationResource = comment
        ? {
            type: 'text',
            data: { text: comment.slice(0, CONTRACT_LIMITS.TEXT_RESOURCE_MAX_LENGTH) },
            ...(review.createdAt === undefined
              ? {}
              : { createdAt: new Date(review.createdAt) }),
          }
        : {
            type: 'metadata',
            data: {
              commentText: 'absent',
              ...(review.rating === undefined ? {} : { rating: review.rating }),
            },
          };

      const context = await agentContext(review.agentId);
      const reviewerId = review.userId?.toString();
      const agentId = review.agentId?.toHexString();

      return {
        subject: {
          externalId: review._id.toHexString(),
          type: 'commerce.review',
          /**
           * The agent's page, because that is where Alia's own users see the
           * review — there is no per-review URL. Omitted when the agent reference
           * is missing rather than pointing at a page that cannot exist.
           */
          ...(agentId === undefined
            ? {}
            : { permalink: `${WEB_ORIGIN}/agents/${agentId}` }),
          ...(reviewerId === undefined ? {} : { author: { oxyUserId: reviewerId } }),
        },
        content,
        ...(context === null ? {} : { context: [context] }),
      };
    },
  };
}

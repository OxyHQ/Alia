import { CONTRACT_LIMITS } from '@oxyhq/crowdsource-contracts';
import { getDb } from '../../../db/index.js';
import { findAgentById } from '../../../db/agents/agentRepository.js';
import { attachAgentIdentity } from '../../agent-identity.js';
import { findAgentReviewById } from '../../../db/agents/agentReviewRepository.js';
import { ReportedType } from '../../../domain/report.js';
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

/**
 * The agent being reviewed, as the minimum a jury needs to read the review.
 *
 * `agent_reviews.agent_id` is `notNull` with a foreign key that CASCADES, so
 * the id is always present and the agent is always there — the `undefined`
 * branch this used to open with is now unreachable, and the remaining `null`
 * answer is for a review read inside the window of a concurrent agent delete.
 */
async function agentContext(agentId: string): Promise<ModerationContextResource | null> {
  const found = await findAgentById(getDb(), agentId);
  if (!found) return null;

  // The name a jury reads has to be the name the marketplace SHOWS, and that is
  // Oxy's. An unresolvable account leaves it blank rather than substituting
  // anything, because the tagline alone is still a truthful context resource.
  const agent = await attachAgentIdentity(found);
  const name = (agent.name ?? '').trim();
  const tagline = agent.tagline.trim();
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
      // No `isValidObjectId` guard — see `agent-subject.ts` for why it had to go.
      const review = await findAgentReviewById(getDb(), reportedId);
      if (!review) return null;

      const comment = review.comment.trim();
      const content: ModerationResource = comment
        ? {
            type: 'text',
            data: { text: comment.slice(0, CONTRACT_LIMITS.TEXT_RESOURCE_MAX_LENGTH) },
            createdAt: review.createdAt,
          }
        : {
            type: 'metadata',
            data: { commentText: 'absent', rating: review.rating },
          };

      const context = await agentContext(review.agentId);
      const reviewerId = review.userId;
      const agentId = review.agentId;

      return {
        subject: {
          externalId: review._id,
          type: 'commerce.review',
          /**
           * The agent's page, because that is where Alia's own users see the
           * review — there is no per-review URL. Omitted when the agent reference
           * is missing rather than pointing at a page that cannot exist.
           */
          permalink: `${WEB_ORIGIN}/agents/${agentId}`,
          author: { oxyUserId: reviewerId },
        },
        content,
        ...(context === null ? {} : { context: [context] }),
      };
    },
  };
}

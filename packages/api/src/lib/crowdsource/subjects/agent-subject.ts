import { CONTRACT_LIMITS } from '@oxyhq/crowdsource-contracts';
import { getDb } from '../../../db/index.js';
import { findAgentById, type AgentRecord } from '../../../db/agents/agentRepository.js';
import { ReportedType } from '../../../domain/report.js';
import type {
  ModerationContextResource,
  ModerationSubjectProvider,
  ModerationSubjectSnapshot,
} from './types.js';

/**
 * A published marketplace agent, as universal material.
 *
 * An agent is a PERSONA a person published in a directory — a name, a face, a
 * tagline, a description and a set of instructions — so it is described as a
 * `profile` resource rather than a `listing`. That is not a cosmetic choice: the
 * contract's `listing` requires `price` and `currency` to travel together, and
 * Alia's `price` is a credit figure with no currency anywhere in the model. A
 * listing resource here could only be built by inventing an ISO 4217 code, which
 * would be Alia asserting something nobody said.
 *
 * ## The system prompt travels as evidence, and only because it is already public
 *
 * `GET /agents/:id` returns the whole agent document, `systemPrompt` included —
 * the list route strips it (`.select('-systemPrompt')`), the detail route does
 * not. So anyone who can see the agent can already read its instructions, and
 * including them costs no disclosure that the permalink does not.
 *
 * It travels as `context` with role `evidence` rather than as the subject's own
 * content, because the two answer different questions. The listing is what the
 * agent CLAIMS to be, which is what an impersonation or scam report is about; the
 * instructions are what it is BUILT to do, which is what a
 * `malicious_instructions` report is about. A jury that gets one without the other
 * can only answer half the reports honestly.
 *
 * ## What is NOT here
 *
 * **The avatar is not attached.** `AssetRef` needs `{ fileId, mimeType, sha256 }`
 * and Alia's `avatar` is a bare string that may be an Oxy file id or an absolute
 * URL from image generation, with no digest recorded anywhere. Sending a URL on
 * Alia's own host would tell that host when its content is under review, and
 * inventing a digest is worse than declaring the gap. So the presence of an avatar
 * is declared in `claims` and a jury can answer `insufficient_context` for the
 * right reason. Closing it needs a digest at upload time, not a fetch here.
 */

const WEB_ORIGIN = process.env.WEB_URL || 'https://alia.onl';

/** A non-empty string clamped to a contract limit, or nothing. */
function bounded(value: string | undefined | null, max: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** A `profile.claims` value: bounded, flat, scalar (§5.3). */
function claim(value: string | undefined | null): string | undefined {
  return bounded(value, CONTRACT_LIMITS.METADATA_STRING_VALUE_MAX_LENGTH);
}

/**
 * The whole record, where a projection used to narrow it.
 *
 * `.select('name handle tagline …')` bought nothing here: every field it named
 * is read below, the row is one agent, and a projection that drifts from the
 * fields the snapshot uses fails by handing a jury a listing with pieces
 * missing rather than by erroring.
 */
type SnapshotAgent = AgentRecord;

/**
 * The instructions the agent runs on, as supporting material.
 *
 * Absent rather than empty when the agent has no system prompt: the contract's
 * text resource requires at least one character, and a resource saying nothing is
 * noise in a reviewer's view that §9.1 asks us to keep minimal.
 */
function instructionsContext(agent: SnapshotAgent): ModerationContextResource | null {
  const prompt = agent.systemPrompt?.trim();
  if (!prompt) return null;
  return {
    role: 'evidence',
    type: 'text',
    data: { text: prompt.slice(0, CONTRACT_LIMITS.TEXT_RESOURCE_MAX_LENGTH) },
  };
}

export function createAgentSubjectProvider(): ModerationSubjectProvider {
  return {
    reportedType: ReportedType.AGENT,
    subjectType: 'custom.alia.agent',

    async snapshot(reportedId: string): Promise<ModerationSubjectSnapshot | null> {
      /**
       * No `isValidObjectId` guard. Ids are uuid v7 now, so that check rejected
       * every real agent — and its failure mode was a `null` snapshot, which the
       * delivery worker reads as "the object was deleted" and closes the report
       * on. A moderation pipeline reporting success while never looking at
       * anything.
       */
      const agent = await findAgentById(getDb(), reportedId);
      if (!agent) return null;

      /**
       * Claims, not evidence. A handle, a category and a tagline are what the
       * listing asserts about itself, which is exactly what an impersonation
       * allegation turns on.
       */
      const claims: Record<string, string> = {};
      const handle = claim(agent.handle);
      if (handle !== undefined) claims.handle = handle;
      const tagline = claim(agent.tagline);
      if (tagline !== undefined) claims.tagline = tagline;
      const category = claim(agent.category);
      if (category !== undefined) claims.category = category;
      const archetype = claim(agent.archetype);
      if (archetype !== undefined) claims.archetype = archetype;
      const tags = claim(agent.tags.join(', '));
      if (tags !== undefined) claims.tags = tags;
      /**
       * The author's DISPLAY name as the listing shows it — a distinct claim from
       * the author's identity, which travels as a principal below. An agent
       * impersonating someone usually does it here.
       */
      const authorName = claim(agent.authorName);
      if (authorName !== undefined) claims.authorName = authorName;
      // Declared, not attached — see the note above.
      claims.avatarPresent = agent.avatar ? 'true' : 'false';

      const context = instructionsContext(agent);
      const ownerId = agent.author;
      /**
       * Read straight off the record and never recomposed. What a jury judges has
       * to be what the marketplace actually shows; a name this code assembled
       * would be evidence Alia invented.
       */
      const displayName = bounded(agent.name, CONTRACT_LIMITS.SHORT_TEXT_MAX_LENGTH);
      const bio = bounded(agent.description, CONTRACT_LIMITS.LONG_TEXT_MAX_LENGTH);

      return {
        subject: {
          externalId: agent._id,
          type: 'custom.alia.agent',
          permalink: `${WEB_ORIGIN}/agents/${agent._id}`,
          author: { oxyUserId: ownerId },
        },
        content: {
          type: 'profile',
          data: {
            ...(displayName === undefined ? {} : { displayName }),
            ...(bio === undefined ? {} : { bio }),
            claims,
          },
        },
        ...(context === null ? {} : { context: [context] }),
      };
    },
  };
}

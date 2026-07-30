import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { ResourceSchema } from '@oxyhq/crowdsource-contracts';

vi.mock('../../../models/agent.js', () => ({ Agent: { findById: vi.fn() } }));
vi.mock('../../../models/agent-review.js', () => ({ AgentReview: { findById: vi.fn() } }));
vi.mock('../../../models/skill.js', () => ({
  Skill: { findById: vi.fn(), findOne: vi.fn() },
}));

import { Agent } from '../../../models/agent.js';
import { AgentReview } from '../../../models/agent-review.js';
import { Skill } from '../../../models/skill.js';
import { createAgentSubjectProvider } from '../subjects/agent-subject.js';
import { createAgentReviewSubjectProvider } from '../subjects/agent-review-subject.js';
import { createSkillSubjectProvider } from '../subjects/skill-subject.js';
import type { ModerationResource } from '../subjects/types.js';

type Mocked = Record<string, ReturnType<typeof vi.fn>>;
const agentModel = Agent as unknown as Mocked;
const reviewModel = AgentReview as unknown as Mocked;
const skillModel = Skill as unknown as Mocked;

const AGENT_ID = '507f1f77bcf86cd799439011';
const REVIEW_ID = '507f1f77bcf86cd799439012';
const SKILL_ID = '507f1f77bcf86cd799439013';
const AUTHOR_ID = '507f1f77bcf86cd799439014';

/** A `find`-style chain ending in `.lean()`. */
function chain(value: unknown) {
  return {
    select: () => ({ lean: async () => value, populate: () => ({ lean: async () => value }) }),
    lean: async () => value,
  };
}

/**
 * A resource a provider emitted, checked against the contract's own schema.
 *
 * A provider's output is a `ResourceInput`, not a `Resource`: the SDK fills in
 * `id`, `role` and `sha256`, and converts `createdAt` from a `Date` to an ISO
 * string (`composeResource` in the SDK's `envelope.ts`). Those four are supplied
 * here so the REAL contract does the checking on everything else — a restatement
 * of the schema in this file would pass happily while the envelope was rejected
 * in production, non-retryably, days later.
 */
function assertContractValid(resource: ModerationResource): void {
  const { createdAt, ...rest } = resource;
  const parsed = ResourceSchema.safeParse({
    id: 'res_subject',
    role: 'subject',
    sha256: `sha256:${'0'.repeat(64)}`,
    ...rest,
    ...(createdAt === undefined
      ? {}
      : { createdAt: new Date(createdAt).toISOString() }),
  });
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
}

describe('agent subject provider', () => {
  const provider = createAgentSubjectProvider();

  beforeEach(() => vi.clearAllMocks());

  it('describes the listing as a profile and the instructions as evidence', async () => {
    agentModel.findById.mockReturnValue(
      chain({
        _id: new mongoose.Types.ObjectId(AGENT_ID),
        name: 'Helpful Bot',
        handle: 'helpful',
        tagline: 'Does helpful things',
        description: 'A long description',
        category: 'productivity',
        archetype: 'general',
        tags: ['a', 'b'],
        avatar: 'file-1',
        systemPrompt: 'You are helpful.',
        author: new mongoose.Types.ObjectId(AUTHOR_ID),
        authorName: 'Nate',
      }),
    );

    const snapshot = await provider.snapshot(AGENT_ID);
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;

    expect(snapshot.subject.type).toBe('custom.alia.agent');
    expect(snapshot.subject.externalId).toBe(AGENT_ID);
    expect(snapshot.subject.author?.oxyUserId).toBe(AUTHOR_ID);

    const content = snapshot.content as ModerationResource;
    expect(content.type).toBe('profile');
    assertContractValid(content);

    // The listing's claims are what an impersonation report turns on.
    expect(content).toMatchObject({
      data: {
        displayName: 'Helpful Bot',
        bio: 'A long description',
        claims: { handle: 'helpful', authorName: 'Nate' },
      },
    });

    // The instructions are what a malicious-instructions report turns on, and
    // they are already public through `GET /agents/:id`.
    expect(snapshot.context).toHaveLength(1);
    expect(snapshot.context?.[0]).toMatchObject({
      role: 'evidence',
      type: 'text',
      data: { text: 'You are helpful.' },
    });
  });

  /**
   * Read straight off the record. A display name this code assembled from other
   * fields would be evidence Alia invented, and a jury has to judge what the
   * marketplace actually shows.
   */
  it('omits a display name it does not have rather than composing one', async () => {
    agentModel.findById.mockReturnValue(
      chain({
        _id: new mongoose.Types.ObjectId(AGENT_ID),
        handle: 'nameless',
        description: 'has a description',
        author: new mongoose.Types.ObjectId(AUTHOR_ID),
      }),
    );

    const snapshot = await provider.snapshot(AGENT_ID);
    const content = snapshot?.content as ModerationResource;
    expect(content.type).toBe('profile');
    expect(content).not.toHaveProperty('data.displayName');
    // The handle travels separately, as a claim — never substituted for a name.
    expect(content).toMatchObject({ data: { claims: { handle: 'nameless' } } });
  });

  /** Declared, not attached: there is no digest for an avatar anywhere in Alia. */
  it('declares whether an avatar exists instead of attaching it', async () => {
    agentModel.findById.mockReturnValue(
      chain({ _id: new mongoose.Types.ObjectId(AGENT_ID), name: 'A', avatar: 'file-1' }),
    );
    const withAvatar = await provider.snapshot(AGENT_ID);
    expect(withAvatar?.content).toMatchObject({ data: { claims: { avatarPresent: 'true' } } });
    expect(withAvatar?.attachments).toBeUndefined();

    agentModel.findById.mockReturnValue(
      chain({ _id: new mongoose.Types.ObjectId(AGENT_ID), name: 'A', avatar: null }),
    );
    const withoutAvatar = await provider.snapshot(AGENT_ID);
    expect(withoutAvatar?.content).toMatchObject({
      data: { claims: { avatarPresent: 'false' } },
    });
  });

  it('emits no context when the agent has no system prompt', async () => {
    agentModel.findById.mockReturnValue(
      chain({ _id: new mongoose.Types.ObjectId(AGENT_ID), name: 'A', systemPrompt: '  ' }),
    );
    expect((await provider.snapshot(AGENT_ID))?.context).toBeUndefined();
  });

  it('returns null for a deleted agent and for an id that is not one', async () => {
    agentModel.findById.mockReturnValue(chain(null));
    expect(await provider.snapshot(AGENT_ID)).toBeNull();
    expect(await provider.snapshot('not-an-object-id')).toBeNull();
  });
});

describe('agent review subject provider', () => {
  const provider = createAgentReviewSubjectProvider();

  beforeEach(() => vi.clearAllMocks());

  it('describes the comment, with the agent as context', async () => {
    reviewModel.findById.mockReturnValue(
      chain({
        _id: new mongoose.Types.ObjectId(REVIEW_ID),
        agentId: new mongoose.Types.ObjectId(AGENT_ID),
        userId: new mongoose.Types.ObjectId(AUTHOR_ID),
        rating: 1,
        comment: 'This is garbage',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      }),
    );
    agentModel.findById.mockReturnValue(
      chain({ _id: new mongoose.Types.ObjectId(AGENT_ID), name: 'Bot', tagline: 'Tag' }),
    );

    const snapshot = await provider.snapshot(REVIEW_ID);
    expect(snapshot?.subject.type).toBe('commerce.review');
    // The reviewer is the author of the review — not the agent's owner.
    expect(snapshot?.subject.author?.oxyUserId).toBe(AUTHOR_ID);

    const content = snapshot?.content as ModerationResource;
    expect(content).toMatchObject({ type: 'text', data: { text: 'This is garbage' } });
    assertContractValid(content);

    /**
     * A review cannot be judged alone: the same words are harassment or a fair
     * review depending entirely on what is being reviewed.
     */
    expect(snapshot?.context?.[0]).toMatchObject({
      role: 'context',
      type: 'text',
      data: { text: 'Bot — Tag' },
    });
  });

  /**
   * A rating with no comment is normal and the contract's text resource requires
   * at least one character — correctly. Describing it as a metadata resource says
   * what the review consisted of without inventing words for it.
   */
  it('describes a rating-only review as metadata rather than as empty text', async () => {
    reviewModel.findById.mockReturnValue(
      chain({
        _id: new mongoose.Types.ObjectId(REVIEW_ID),
        agentId: new mongoose.Types.ObjectId(AGENT_ID),
        userId: new mongoose.Types.ObjectId(AUTHOR_ID),
        rating: 3,
        comment: '',
      }),
    );
    agentModel.findById.mockReturnValue(chain(null));

    const content = (await provider.snapshot(REVIEW_ID))?.content as ModerationResource;
    expect(content).toMatchObject({
      type: 'metadata',
      data: { commentText: 'absent', rating: 3 },
    });
    assertContractValid(content);
  });

  it('returns null for a deleted review', async () => {
    reviewModel.findById.mockReturnValue(chain(null));
    expect(await provider.snapshot(REVIEW_ID)).toBeNull();
  });
});

describe('skill subject provider', () => {
  const provider = createSkillSubjectProvider();

  beforeEach(() => vi.clearAllMocks());

  function communitySkill(overrides: Record<string, unknown> = {}) {
    return {
      _id: new mongoose.Types.ObjectId(SKILL_ID),
      skillId: 'my-skill',
      title: 'My Skill',
      tagline: 'A tagline',
      description: 'A description',
      systemPrompt: 'Do the thing.',
      isBuiltIn: false,
      oxyUserId: new mongoose.Types.ObjectId(AUTHOR_ID),
      ...overrides,
    };
  }

  it('describes the listing, with the prompt as evidence', async () => {
    skillModel.findOne.mockReturnValue(chain(communitySkill()));

    const snapshot = await provider.snapshot('my-skill');
    expect(snapshot?.subject.type).toBe('custom.alia.skill');
    expect(snapshot?.subject.author?.oxyUserId).toBe(AUTHOR_ID);

    const content = snapshot?.content as ModerationResource;
    expect(content).toMatchObject({
      type: 'listing',
      data: { title: 'My Skill', description: 'A tagline\n\nA description' },
    });
    assertContractValid(content);
    expect(snapshot?.context?.[0]).toMatchObject({ role: 'evidence', type: 'text' });
  });

  /**
   * `price` and `currency` must travel together on a listing, and a skill has
   * neither. Emitting a price without a currency is a contract rejection; emitting
   * an invented currency is Alia asserting something nobody said.
   */
  it('emits no price on the listing', async () => {
    skillModel.findOne.mockReturnValue(chain(communitySkill()));
    const content = (await provider.snapshot('my-skill'))?.content as ModerationResource;
    expect(content).not.toHaveProperty('data.price');
    expect(content).not.toHaveProperty('data.currency');
  });

  /**
   * The external id is what §7.3's dedup key is computed over, and the slug is
   * derived from the title — which the owner can edit. Two reports about one skill
   * either side of a rename must reach the same case.
   */
  it('keys the subject on the immutable id, not on the editable slug', async () => {
    skillModel.findOne.mockReturnValue(chain(communitySkill()));
    const snapshot = await provider.snapshot('my-skill');
    expect(snapshot?.subject.externalId).toBe(SKILL_ID);
    expect(snapshot?.subject.permalink).toContain('/skills/my-skill');
  });

  it('resolves a skill by its ObjectId as well as by its slug', async () => {
    skillModel.findOne.mockReturnValue(chain(null));
    skillModel.findById.mockReturnValue(chain(communitySkill()));
    expect((await provider.snapshot(SKILL_ID))?.subject.externalId).toBe(SKILL_ID);
  });

  /**
   * A built-in skill is Alia's own product, not somebody's published work. A
   * complaint about one belongs in a support channel, not in front of a jury drawn
   * to judge a person.
   */
  it('declines a built-in skill', async () => {
    skillModel.findOne.mockReturnValue(chain(communitySkill({ isBuiltIn: true })));
    expect(await provider.snapshot('my-skill')).toBeNull();
  });

  it('declines a corrupted row with no title rather than inventing one', async () => {
    skillModel.findOne.mockReturnValue(chain(communitySkill({ title: '  ' })));
    expect(await provider.snapshot('my-skill')).toBeNull();
  });
});

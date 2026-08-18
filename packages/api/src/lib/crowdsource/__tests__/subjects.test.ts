import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceSchema } from '@oxyhq/crowdsource-contracts';

vi.mock('../../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../../db/agents/agentRepository.js', () => ({ findAgentById: vi.fn() }));
vi.mock('../../../db/agents/agentReviewRepository.js', () => ({ findAgentReviewById: vi.fn() }));
vi.mock('../../../db/agents/skillRepository.js', () => ({ findReportedSkill: vi.fn() }));

import { findAgentById } from '../../../db/agents/agentRepository.js';
import { findAgentReviewById } from '../../../db/agents/agentReviewRepository.js';
import {
  findReportedSkill,
  type ModerationSkill,
} from '../../../db/agents/skillRepository.js';
import { createAgentSubjectProvider } from '../subjects/agent-subject.js';
import { createAgentReviewSubjectProvider } from '../subjects/agent-review-subject.js';
import { createSkillSubjectProvider } from '../subjects/skill-subject.js';
import type { ModerationResource } from '../subjects/types.js';

const findAgent = vi.mocked(findAgentById);
const findReview = vi.mocked(findAgentReviewById);
const findReportedSkillMock = vi.mocked(findReportedSkill);

/**
 * The agent and review ids are uuid v7; the skill ones stay 24-hex.
 *
 * Not cosmetic. Both providers used to open with
 * `mongoose.isValidObjectId(reportedId)` and answer `null` for anything else —
 * which, against these ids, is EVERY subject. The delivery worker reads that
 * null as "the object was deleted" and closes the report locally, so a
 * moderation pipeline would have reported success while never looking at
 * anything. Real-shaped ids are what make the guard's removal testable at all:
 * with 24-hex fixtures the old code passes too.
 */
const AGENT_ID = '01996a6f-0000-7000-8000-00000000a9e1';
const REVIEW_ID = '01996a6f-0000-7000-8000-00000000a9e2';
const SKILL_ID = '507f1f77bcf86cd799439013';
const AUTHOR_ID = '507f1f77bcf86cd799439014';

/** A full agent record, with the fields a subject reads overridden. */
function agentRecord(overrides: Record<string, unknown> = {}) {
  return {
    _id: AGENT_ID,
    id: AGENT_ID,
    name: 'Helpful Bot',
    handle: 'helpful',
    avatar: 'file-1',
    tagline: 'Does helpful things',
    description: 'A long description',
    author: AUTHOR_ID,
    authorName: 'Nate',
    authorVerified: false,
    category: 'productivity',
    tags: ['a', 'b'],
    rating: 0,
    reviewCount: 0,
    usageCount: 0,
    hireCount: 0,
    price: null,
    capabilities: [],
    isVerified: false,
    isFeatured: false,
    isTrending: false,
    isPublished: true,
    status: 'active',
    creditBalance: 0,
    allowHiring: false,
    systemPrompt: 'You are helpful.',
    preferredImage: null,
    allowedModels: [],
    scheduleInterval: null,
    lastScheduledCheck: null,
    archetype: 'general',
    archetypeConfig: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as Awaited<ReturnType<typeof findAgentById>>;
}

function reviewRecord(overrides: Record<string, unknown> = {}) {
  return {
    _id: REVIEW_ID,
    id: REVIEW_ID,
    agentId: AGENT_ID,
    userId: AUTHOR_ID,
    rating: 1,
    comment: 'This is garbage',
    hiddenByModeration: false,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as Awaited<ReturnType<typeof findAgentReviewById>>;
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
    findAgent.mockResolvedValue(agentRecord());

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
   * The removal of `isValidObjectId`, asserted directly.
   *
   * This is the positive control for the fixture ids: it fails against a
   * provider that still shape-checks its argument, and no other case in this
   * file distinguishes the two — a lookup that is never reached and a lookup
   * that misses both produce `null`.
   */
  it('looks a uuid subject up instead of refusing it on shape', async () => {
    findAgent.mockResolvedValue(agentRecord());
    await provider.snapshot(AGENT_ID);
    expect(findAgent).toHaveBeenCalledWith(expect.anything(), AGENT_ID);
  });

  /**
   * Read straight off the record. A display name this code assembled from other
   * fields would be evidence Alia invented, and a jury has to judge what the
   * marketplace actually shows.
   */
  it('omits a display name it does not have rather than composing one', async () => {
    findAgent.mockResolvedValue(
      agentRecord({ name: '', handle: 'nameless', description: 'has a description' }),
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
    findAgent.mockResolvedValue(agentRecord({ avatar: 'file-1' }));
    const withAvatar = await provider.snapshot(AGENT_ID);
    expect(withAvatar?.content).toMatchObject({ data: { claims: { avatarPresent: 'true' } } });
    expect(withAvatar?.attachments).toBeUndefined();

    findAgent.mockResolvedValue(agentRecord({ avatar: null }));
    const withoutAvatar = await provider.snapshot(AGENT_ID);
    expect(withoutAvatar?.content).toMatchObject({
      data: { claims: { avatarPresent: 'false' } },
    });
  });

  it('emits no context when the agent has no system prompt', async () => {
    findAgent.mockResolvedValue(agentRecord({ systemPrompt: '  ' }));
    expect((await provider.snapshot(AGENT_ID))?.context).toBeUndefined();
  });

  it('returns null for a deleted agent', async () => {
    findAgent.mockResolvedValue(null);
    expect(await provider.snapshot(AGENT_ID)).toBeNull();
  });
});

describe('agent review subject provider', () => {
  const provider = createAgentReviewSubjectProvider();

  beforeEach(() => vi.clearAllMocks());

  it('describes the comment, with the agent as context', async () => {
    findReview.mockResolvedValue(reviewRecord());
    findAgent.mockResolvedValue(agentRecord({ name: 'Bot', tagline: 'Tag' }));

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
    findReview.mockResolvedValue(reviewRecord({ rating: 3, comment: '' }));
    findAgent.mockResolvedValue(null);

    const content = (await provider.snapshot(REVIEW_ID))?.content as ModerationResource;
    expect(content).toMatchObject({
      type: 'metadata',
      data: { commentText: 'absent', rating: 3 },
    });
    assertContractValid(content);
  });

  it('returns null for a deleted review', async () => {
    findReview.mockResolvedValue(null);
    expect(await provider.snapshot(REVIEW_ID)).toBeNull();
  });
});

describe('skill subject provider', () => {
  const provider = createSkillSubjectProvider();

  beforeEach(() => vi.clearAllMocks());

  /**
   * A row as `findReportedSkill` hands it back — every column NOT NULL except
   * `oxy_user_id`, which is null for a built-in.
   *
   * The fixture is typed, so a column the repository stops selecting fails this
   * file rather than surfacing as an `undefined` the provider quietly formats.
   */
  function communitySkill(overrides: Partial<ModerationSkill> = {}): ModerationSkill {
    return {
      id: SKILL_ID,
      skillId: 'my-skill',
      title: 'My Skill',
      tagline: 'A tagline',
      description: 'A description',
      systemPrompt: 'Do the thing.',
      category: 'community',
      language: 'en-US',
      isBuiltIn: false,
      oxyUserId: AUTHOR_ID,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  it('describes the listing, with the prompt as evidence', async () => {
    findReportedSkillMock.mockResolvedValue(communitySkill());

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
    findReportedSkillMock.mockResolvedValue(communitySkill());
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
    findReportedSkillMock.mockResolvedValue(communitySkill());
    const snapshot = await provider.snapshot('my-skill');
    expect(snapshot?.subject.externalId).toBe(SKILL_ID);
    expect(snapshot?.subject.permalink).toContain('/skills/my-skill');
  });

  /**
   * Resolving a report by EITHER identifier is now one SQL statement, so the
   * assertion that both work lives where the statement does —
   * `skillRepository.pgdb.test.ts`, against a real server. Mocking
   * `findReportedSkill` here could only prove that this file's mock returns what
   * it was told to.
   *
   * What is still this file's to check is that the provider passes the reported
   * id THROUGH rather than assuming a slug: it is the only caller.
   */
  it('hands the reported id to the repository unchanged, whichever form it is', async () => {
    findReportedSkillMock.mockResolvedValue(communitySkill());
    await provider.snapshot(SKILL_ID);
    expect(findReportedSkillMock).toHaveBeenCalledWith(expect.anything(), SKILL_ID);

    findReportedSkillMock.mockClear();
    await provider.snapshot('my-skill');
    expect(findReportedSkillMock).toHaveBeenCalledWith(expect.anything(), 'my-skill');
  });

  /**
   * A built-in skill is Alia's own product, not somebody's published work. A
   * complaint about one belongs in a support channel, not in front of a jury drawn
   * to judge a person.
   */
  it('declines a built-in skill', async () => {
    findReportedSkillMock.mockResolvedValue(communitySkill({ isBuiltIn: true }));
    expect(await provider.snapshot('my-skill')).toBeNull();
  });

  it('declines a corrupted row with no title rather than inventing one', async () => {
    findReportedSkillMock.mockResolvedValue(communitySkill({ title: '  ' }));
    expect(await provider.snapshot('my-skill')).toBeNull();
  });
});

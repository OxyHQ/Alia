import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  target: vi.fn(),
  mutate: vi.fn(),
  conversation: vi.fn(),
  members: vi.fn(),
  agent: vi.fn(),
  reach: vi.fn(),
  external: vi.fn(),
}));
vi.mock('../../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../../db/chat/reactionRepository.js', () => ({
  findReactionTarget: h.target,
  mutateMessageReaction: h.mutate,
}));
vi.mock('../../../../db/chat/conversationRepository.js', () => ({
  findConversation: h.conversation,
}));
vi.mock('../../../../db/chat/conversationMemberRepository.js', () => ({
  listGroupMembers: h.members,
}));
vi.mock('../../../../db/agents/agentRepository.js', () => ({ findAgentById: h.agent }));
vi.mock('../../../agent-account.js', () => ({ canReachAgent: h.reach }));
vi.mock('../../../external-agents/turn.js', () => ({ isExternalAgent: h.external }));
const { applyConversationReaction } = await import('../mutation.js');
const input = {
  userId: 'person',
  conversationId: 'room',
  messageId: 'answer',
  accessToken: 'session',
  surfaceApplicationId: 'verified-app',
  mutation: { emoji: '❤️', active: true, mutationId: 'mutation' },
};
beforeEach(() => {
  vi.clearAllMocks();
  h.target.mockResolvedValue({
    messageId: 'answer',
    targetActorId: 'salina',
    role: 'assistant',
    content: 'hello',
  });
  h.agent.mockResolvedValue({ id: 'salina' });
  h.members.mockResolvedValue(['salina']);
  h.conversation.mockResolvedValue({ agentId: null });
  h.reach.mockResolvedValue('reachable');
  h.external.mockResolvedValue(false);
  h.mutate.mockResolvedValue({
    messageId: 'answer',
    reactions: ['❤️'],
    revision: 1,
    mutationId: 'mutation',
  });
});
describe('reaction authority at mutation edge', () => {
  it('authorizes only stored target membership with the reacting person and verified app surface', async () => {
    await applyConversationReaction(input);
    expect(h.target).toHaveBeenCalledWith({}, 'person', 'room', 'answer');
    expect(h.reach).toHaveBeenCalledWith(
      { id: 'salina' },
      { oxyUserId: 'person', accessToken: 'session', surfaceApplicationId: 'verified-app' },
    );
    expect(h.mutate).toHaveBeenCalledWith(
      {},
      'person',
      'room',
      'answer',
      expect.objectContaining({
        authorizedActorId: 'salina',
        surfaceApplicationId: 'verified-app',
      }),
    );
  });
  it('supports a direct agent thread without group members', async () => {
    h.members.mockResolvedValue([]);
    h.conversation.mockResolvedValue({ agentId: 'salina' });
    await applyConversationReaction(input);
    expect(h.mutate.mock.calls[0]?.[4].authorizedActorId).toBe('salina');
  });
  it.each(['out_of_reach', 'identity_unavailable'])(
    'preserves feedback without waking an unavailable recipient: %s',
    async (reach) => {
      h.reach.mockResolvedValue(reach);
      await applyConversationReaction(input);
      expect(h.mutate.mock.calls[0]?.[4].authorizedActorId).toBeUndefined();
    },
  );
  it('will not follow an attributed actor outside current membership', async () => {
    h.members.mockResolvedValue(['someone-else']);
    await applyConversationReaction(input);
    expect(h.reach).not.toHaveBeenCalled();
    expect(h.mutate.mock.calls[0]?.[4].authorizedActorId).toBeUndefined();
  });
  it('retains feedback when live authority lookup fails, without authorizing a response', async () => {
    h.reach.mockRejectedValueOnce(new Error('identity unavailable'));
    await applyConversationReaction(input);
    expect(h.mutate.mock.calls[0]?.[4].authorizedActorId).toBeUndefined();
  });
  it('does not make an external task or fake Alia identity for feedback', async () => {
    h.external.mockResolvedValue(true);
    await applyConversationReaction(input);
    expect(h.mutate.mock.calls[0]?.[4].authorizedActorId).toBeUndefined();
    h.target.mockResolvedValue({ messageId: 'answer', targetActorId: null, role: 'assistant' });
    await applyConversationReaction(input);
    expect(h.mutate.mock.calls[1]?.[4].authorizedActorId).toBeUndefined();
  });
  it('removal never checks reach or asks an actor to respond', async () => {
    await applyConversationReaction({ ...input, mutation: { ...input.mutation, active: false } });
    expect(h.reach).not.toHaveBeenCalled();
    expect(h.mutate.mock.calls[0]?.[4].authorizedActorId).toBeUndefined();
  });
  it('never reveals or mutates a target outside the owner-scoped lookup', async () => {
    h.target.mockResolvedValue(undefined);
    expect(await applyConversationReaction(input)).toBeUndefined();
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.agent).not.toHaveBeenCalled();
  });
});

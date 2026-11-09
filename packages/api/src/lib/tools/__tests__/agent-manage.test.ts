import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  applyAgentEdit: vi.fn(),
  agentAnswer: vi.fn(),
  refuseUnknownModel: vi.fn(),
  listAgentsByAuthor: vi.fn(),
  attachAgentIdentities: vi.fn(),
}));

vi.mock('../../agent-update.js', () => ({
  applyAgentEdit: mocks.applyAgentEdit,
  agentAnswer: mocks.agentAnswer,
  refuseUnknownModel: mocks.refuseUnknownModel,
}));
vi.mock('../../agent-identity.js', () => ({ attachAgentIdentities: mocks.attachAgentIdentities }));
vi.mock('../../../db/agents/agentRepository.js', () => ({
  listAgentsByAuthor: mocks.listAgentsByAuthor,
}));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../logger.js', () => ({ log: { general: { info: vi.fn(), error: vi.fn() } } }));

const { listMyAgentsTool, updateAgentTool } = await import('../agent-manage.js');

const run = (t: unknown, input: unknown) =>
  (t as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, {
    toolCallId: 't',
    messages: [],
  });

const record = {
  _id: 'a1',
  name: 'Nadia',
  handle: 'nadia',
  tagline: 'Finds things',
  category: 'Research',
  isPublished: false,
  capabilityGrants: ['web'],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refuseUnknownModel.mockResolvedValue(null);
  mocks.agentAnswer.mockImplementation(async (agent: unknown) => agent);
});

describe('listMyAgents', () => {
  it('lists the caller’s own agents with their identity', async () => {
    mocks.listAgentsByAuthor.mockResolvedValue([record]);
    mocks.attachAgentIdentities.mockImplementation(async (agents: unknown) => agents);
    expect(await run(listMyAgentsTool('u1'), {})).toEqual({
      success: true,
      agents: [
        {
          id: 'a1',
          name: 'Nadia',
          handle: 'nadia',
          tagline: 'Finds things',
          category: 'Research',
          isPublished: false,
          capabilityGrants: ['web'],
        },
      ],
    });
    expect(mocks.listAgentsByAuthor).toHaveBeenCalledWith(expect.anything(), 'u1');
  });
});

describe('updateAgent', () => {
  it('sends only the fields asked for, as the caller, and the name to the account', async () => {
    mocks.applyAgentEdit.mockResolvedValue({ ok: true, agent: record });
    const result = await run(updateAgentTool('u1', 'token'), {
      agentId: 'a1',
      name: 'Nadia',
      tagline: 'Finds things',
    });
    expect(mocks.applyAgentEdit).toHaveBeenCalledWith({
      agentId: 'a1',
      userId: 'u1',
      accessToken: 'token',
      edit: { tagline: 'Finds things' },
      account: { displayName: 'Nadia' },
    });
    expect(result).toMatchObject({ success: true, agent: { id: 'a1' } });
  });

  it('relays a refusal in words, never throwing the turn', async () => {
    mocks.applyAgentEdit.mockResolvedValue({ ok: false, status: 404, error: 'Agent not found' });
    expect(await run(updateAgentTool('u1', 'token'), { agentId: 'nope', tagline: 'x' })).toEqual({
      success: false,
      error: 'Agent not found',
    });
  });

  it('refuses an unknown model before anything is written', async () => {
    mocks.refuseUnknownModel.mockResolvedValue({ error: 'No such model', param: 'modelId' });
    expect(await run(updateAgentTool('u1', 'token'), { agentId: 'a1', modelId: 'x/y' })).toEqual({
      success: false,
      error: 'No such model',
    });
    expect(mocks.applyAgentEdit).not.toHaveBeenCalled();
  });

  it('needs a signed-in session: an API-key turn has no bearer to act as the account', async () => {
    expect(await run(updateAgentTool('u1', undefined), { agentId: 'a1', tagline: 'x' })).toEqual({
      success: false,
      error: 'Changing an agent requires a signed-in session.',
    });
    expect(mocks.applyAgentEdit).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findSpaceBrief = vi.fn();
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/spaces/spaceRepository.js', () => ({ findSpaceBrief }));

const { agentSpacePrompt, spaceSection } = await import('../space-prompt.js');

describe('spaceSection', () => {
  it('names the space, its brief and who the agent deals with', () => {
    const text = spaceSection({ name: 'Marketing', instructions: 'Launch the newsletter.' });

    expect(text.startsWith('\n\n## Your space')).toBe(true);
    expect(text).toContain('the space "Marketing"');
    expect(text).toContain('Launch the newsletter.');
    expect(text).toContain('only with them, with the person, and with Alia');
  });

  it('leaves out the purpose line when the space has no brief', () => {
    expect(spaceSection({ name: 'Marketing', instructions: '' })).not.toContain(
      'What the space is for',
    );
  });
});

describe('agentSpacePrompt', () => {
  beforeEach(() => findSpaceBrief.mockReset());

  it('is empty for an agent in no space, without asking the database', async () => {
    expect(await agentSpacePrompt({ spaceId: null })).toBe('');
    expect(await agentSpacePrompt({} as { spaceId: string | null })).toBe('');
    expect(findSpaceBrief).not.toHaveBeenCalled();
  });

  it('is the section of the agent’s space', async () => {
    findSpaceBrief.mockResolvedValue({ name: 'Marketing', instructions: 'Ship it' });

    const text = await agentSpacePrompt({ spaceId: 'space-1' });

    expect(findSpaceBrief).toHaveBeenCalledWith({}, 'space-1');
    expect(text).toContain('the space "Marketing"');
    expect(text).toContain('Ship it');
  });

  it('is empty when the space is gone, rather than naming one that no longer exists', async () => {
    findSpaceBrief.mockResolvedValue(null);
    expect(await agentSpacePrompt({ spaceId: 'deleted' })).toBe('');
  });
});

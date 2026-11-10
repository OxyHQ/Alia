import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashAgentMemory } from '../memory-contract.js';

class Conflict extends Error {}
const repo = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/spaces/spaceMemoryRepository.js', () => ({
  SpaceNotesConflictError: Conflict,
  listSpaceNotes: repo.list,
  readSpaceNotes: repo.read,
  writeSpaceNotes: repo.write,
  deleteSpaceNotes: repo.remove,
}));

const { buildSpaceNotesTool } = await import('../space-notes-tool.js');

const tool = buildSpaceNotesTool({ spaceId: 'space-1', agentId: 'agent-1' });
type Input = { action: string; path?: string; content?: string };
const run = (input: Input) =>
  (tool.execute as unknown as (i: Input, o: never) => Promise<string>)(input, {} as never);

beforeEach(() => {
  for (const fn of Object.values(repo)) fn.mockReset();
  repo.write.mockResolvedValue({});
});

describe('spaceNotes', () => {
  it('lists the files, or says there are none', async () => {
    repo.list.mockResolvedValueOnce([]);
    expect(await run({ action: 'list' })).toBe('No notes yet.');
    repo.list.mockResolvedValueOnce([{ path: 'MEMORY.md', byteLength: 12 }]);
    expect(await run({ action: 'list' })).toBe('MEMORY.md (12 bytes)');
  });

  it('reads the index by default', async () => {
    repo.read.mockResolvedValue({ content: '- decided X', contentHash: 'h' });
    expect(await run({ action: 'read' })).toBe('- decided X');
    expect(repo.read).toHaveBeenCalledWith({}, 'space-1', 'MEMORY.md');
  });

  it('appends a line after what is there, writing with the hash it read and its own id as editor', async () => {
    repo.read.mockResolvedValue({ content: '- a\n', contentHash: 'hash-a' });

    expect(await run({ action: 'append', content: '- b' })).toBe('Saved MEMORY.md.');

    expect(repo.write).toHaveBeenCalledWith(
      {},
      {
        spaceId: 'space-1',
        path: 'MEMORY.md',
        content: '- a\n- b\n',
        expectedHash: 'hash-a',
        editor: 'agent-1',
      },
    );
  });

  it('names the hash of nothing when the file does not exist yet', async () => {
    repo.read.mockResolvedValue(undefined);
    await run({ action: 'replace', path: 'memory/launch.md', content: 'plan' });
    expect(repo.write).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ path: 'memory/launch.md', expectedHash: hashAgentMemory('') }),
    );
  });

  it('tells the agent to read again when another writer got there first', async () => {
    repo.read.mockResolvedValue({ content: '', contentHash: 'h' });
    repo.write.mockRejectedValue(new Conflict());

    const answer = await run({ action: 'append', content: 'x' });

    expect(answer).toContain('changed while you were writing');
    expect(answer).toContain('Read the file again');
  });

  it('refuses an empty write, an oversized file and a path outside the contract', async () => {
    repo.read.mockResolvedValue(undefined);
    expect(await run({ action: 'append', content: '   ' })).toContain('content is required');
    expect(await run({ action: 'replace', content: 'x'.repeat(300 * 1024) })).toContain(
      'too large',
    );
    expect(await run({ action: 'read', path: '../../etc/passwd' })).toMatch(/^Error:/);
    expect(repo.write).not.toHaveBeenCalled();
  });

  it('forgets a file, and says when there was none', async () => {
    repo.remove.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    expect(await run({ action: 'forget', path: 'memory/old.md' })).toBe('Removed memory/old.md.');
    expect(await run({ action: 'forget', path: 'memory/old.md' })).toBe(
      'memory/old.md did not exist.',
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Progressive disclosure, at the level of one turn.
 *
 * This is the gap the old feature left entirely uncovered: nothing asserted
 * that a skill ever reached the model. Its own tests mocked the prompt lookup to
 * `undefined` and checked that the request survived.
 *
 * The repository is mocked because what is being measured is the ASSEMBLY — what
 * goes in the index, what gets inlined, what a tool will hand back, and above
 * all what a name outside the candidate set can reach, which is nothing.
 */

vi.mock('../../../db/agents/skillRepository.js', () => ({
  findInstalledSkillVersion: vi.fn(),
  findSkillFileByPath: vi.fn(),
  findSkillVersionById: vi.fn(),
  listInstalledSkillMetadata: vi.fn(),
  listSkillMetadataByIds: vi.fn(),
  listVersionFiles: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import {
  findInstalledSkillVersion,
  findSkillFileByPath,
  findSkillVersionById,
  listInstalledSkillMetadata,
  listSkillMetadataByIds,
  listVersionFiles,
} from '../../../db/agents/skillRepository.js';
import { buildSkillRuntime } from '../runtime.js';

const db = {} as never;
const USER = 'oxy-user-1';

function metadata(name: string, overrides: Record<string, unknown> = {}) {
  return { skillId: `id-${name}`, name, description: `Does ${name}. Use when ${name} is needed.`, autoInvoke: true, version: 1, ...overrides };
}

function version(name: string, body = `Instructions for ${name}.`) {
  return {
    skillId: `id-${name}`,
    name,
    displayName: name,
    versionId: `v-${name}`,
    version: 1,
    body,
    allowedTools: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listSkillMetadataByIds).mockResolvedValue([]);
  vi.mocked(listVersionFiles).mockResolvedValue([]);
  vi.mocked(findInstalledSkillVersion).mockImplementation(async (_db, _user, name) => version(name) as never);
  vi.mocked(findSkillVersionById).mockImplementation(async (_db, id) => version(String(id).replace('id-', '')) as never);
});

describe('level one: the index', () => {
  it('carries a name and a description per installed skill, and nothing else', async () => {
    vi.mocked(listInstalledSkillMetadata).mockResolvedValue([metadata('pdf-processing'), metadata('writing-tests')] as never);

    const runtime = await buildSkillRuntime({ db, oxyUserId: USER });

    expect(runtime.index).toContain('## Skills');
    expect(runtime.index).toContain('- pdf-processing: Does pdf-processing. Use when pdf-processing is needed.');
    expect(runtime.index).toContain('- writing-tests:');
    expect(runtime.index).toContain('loadSkill');
    expect(runtime.active).toBe('');
  });

  it('is empty when nothing is installed, and exposes no tools', async () => {
    vi.mocked(listInstalledSkillMetadata).mockResolvedValue([]);
    const runtime = await buildSkillRuntime({ db, oxyUserId: USER });

    expect(runtime.index).toBe('');
    expect(Object.keys(runtime.tools)).toEqual([]);
  });

  it('withholds everything when the turn asked for no skills', async () => {
    const runtime = await buildSkillRuntime({ db, oxyUserId: USER, selectedNames: null });

    expect(runtime.index).toBe('');
    expect(Object.keys(runtime.tools)).toEqual([]);
    expect(vi.mocked(listInstalledSkillMetadata)).not.toHaveBeenCalled();
  });

  it('leaves out a skill the person marked as theirs to invoke', async () => {
    vi.mocked(listInstalledSkillMetadata).mockResolvedValue([
      metadata('deploy', { autoInvoke: false }),
      metadata('reviewing-code'),
    ] as never);

    const runtime = await buildSkillRuntime({ db, oxyUserId: USER });
    expect(runtime.index).not.toContain('- deploy:');
    expect(runtime.index).toContain('- reviewing-code:');
  });

  /**
   * The system prompt has no budget of its own — every layer appends — so a
   * long shelf would otherwise push the conversation out of the context window
   * from the settings screen.
   */
  it('caps a very long shelf and says how many it left out', async () => {
    const many = Array.from({ length: 90 }, (_, index) => metadata(`skill-${index}`));
    vi.mocked(listInstalledSkillMetadata).mockResolvedValue(many as never);

    const runtime = await buildSkillRuntime({ db, oxyUserId: USER });
    const listed = runtime.index.split('\n').filter((line) => line.startsWith('- ')).length;

    expect(listed).toBeLessThanOrEqual(60);
    expect(runtime.index).toMatch(/\d+ more installed skills are not listed/);
  });

  it('includes the skills linked to the agent this conversation runs', async () => {
    vi.mocked(listInstalledSkillMetadata).mockResolvedValue([]);
    vi.mocked(listSkillMetadataByIds).mockResolvedValue([metadata('agent-owned')] as never);

    const runtime = await buildSkillRuntime({ db, oxyUserId: USER, agentSkillIds: ['id-agent-owned'] });
    expect(runtime.index).toContain('- agent-owned:');
    expect(vi.mocked(listSkillMetadataByIds)).toHaveBeenCalledWith(db, ['id-agent-owned']);
  });
});

describe('level two: activation', () => {
  it('inlines what the person selected and drops it from the index', async () => {
    vi.mocked(listInstalledSkillMetadata).mockResolvedValue([metadata('pdf-processing'), metadata('writing-tests')] as never);

    const runtime = await buildSkillRuntime({ db, oxyUserId: USER, selectedNames: ['pdf-processing'] });

    expect(runtime.active).toContain('# ACTIVE SKILLS');
    expect(runtime.active).toContain('Instructions for pdf-processing.');
    expect(runtime.index).not.toContain('- pdf-processing:');
    expect(runtime.index).toContain('- writing-tests:');
    expect(runtime.activated().map((skill) => skill.name)).toEqual(['pdf-processing']);
  });

  it('ignores a selected name this account cannot reach', async () => {
    vi.mocked(listInstalledSkillMetadata).mockResolvedValue([metadata('pdf-processing')] as never);

    const runtime = await buildSkillRuntime({ db, oxyUserId: USER, selectedNames: ['somebody-elses-skill'] });

    expect(runtime.active).toBe('');
    expect(vi.mocked(findInstalledSkillVersion)).not.toHaveBeenCalled();
  });

  it('reads an agent-linked skill through the link rather than through an install', async () => {
    vi.mocked(listInstalledSkillMetadata).mockResolvedValue([]);
    vi.mocked(listSkillMetadataByIds).mockResolvedValue([metadata('agent-owned')] as never);

    const runtime = await buildSkillRuntime({
      db,
      oxyUserId: USER,
      agentSkillIds: ['id-agent-owned'],
      selectedNames: ['agent-owned'],
    });

    expect(runtime.active).toContain('Instructions for agent-owned.');
    expect(vi.mocked(findSkillVersionById)).toHaveBeenCalled();
    expect(vi.mocked(findInstalledSkillVersion)).not.toHaveBeenCalled();
  });

  it('defers a selection past the budget to loadSkill rather than dropping it', async () => {
    vi.mocked(listInstalledSkillMetadata).mockResolvedValue([metadata('huge'), metadata('small')] as never);
    vi.mocked(findInstalledSkillVersion).mockImplementation(async (_db, _user, name) =>
      version(name, name === 'huge' ? 'x'.repeat(24_001) : 'small body') as never,
    );

    const runtime = await buildSkillRuntime({ db, oxyUserId: USER, selectedNames: ['huge', 'small'] });

    expect(runtime.active).toContain('small body');
    expect(runtime.active).toContain('did not fit here');
  });
});

describe('the loadSkill tool', () => {
  async function toolsFor(names: string[]) {
    vi.mocked(listInstalledSkillMetadata).mockResolvedValue(names.map((name) => metadata(name)) as never);
    const runtime = await buildSkillRuntime({ db, oxyUserId: USER });
    return { runtime, tools: runtime.tools as Record<string, { execute: (input: unknown, opts?: unknown) => Promise<unknown> }> };
  }

  it('returns the instructions, the file list, and marks the skill activated', async () => {
    vi.mocked(listVersionFiles).mockResolvedValue([
      { _id: 'f1', path: 'references/API.md', kind: 'reference', mime: 'text/markdown', bytes: 12, sha256: 'a', contentText: '# API', s3Key: null, executable: false },
    ] as never);
    const { runtime, tools } = await toolsFor(['pdf-processing']);

    const result = (await tools.loadSkill.execute({ name: 'pdf-processing' })) as Record<string, unknown>;

    expect(result.instructions).toBe('Instructions for pdf-processing.');
    expect(result.files).toEqual([{ path: 'references/API.md', kind: 'reference', bytes: 12 }]);
    expect(runtime.activated().map((skill) => skill.name)).toEqual(['pdf-processing']);
  });

  /**
   * The candidate set IS the authorization. A model that invents a name — or is
   * told to load one by a prompt injection inside another skill — reaches
   * nothing, and there is no second code path where that check could be missed.
   */
  it('refuses a name outside the candidate set and says what is available', async () => {
    const { runtime, tools } = await toolsFor(['pdf-processing']);

    const result = (await tools.loadSkill.execute({ name: 'exfiltrate-secrets' })) as Record<string, unknown>;

    expect(result.error).toMatch(/No skill named/);
    expect(result.available).toEqual(['pdf-processing']);
    expect(runtime.activated()).toEqual([]);
    expect(vi.mocked(findInstalledSkillVersion)).not.toHaveBeenCalled();
  });

  it('matches a name case-insensitively, because a model will say it back capitalised', async () => {
    const { tools } = await toolsFor(['pdf-processing']);
    const result = (await tools.loadSkill.execute({ name: '  PDF-Processing ' })) as Record<string, unknown>;
    expect(result.instructions).toBe('Instructions for pdf-processing.');
  });
});

describe('the readSkillFile tool', () => {
  async function tools(name = 'pdf-processing') {
    vi.mocked(listInstalledSkillMetadata).mockResolvedValue([metadata(name)] as never);
    const runtime = await buildSkillRuntime({ db, oxyUserId: USER });
    return runtime.tools as Record<string, { execute: (input: unknown, opts?: unknown) => Promise<unknown> }>;
  }

  it('returns the text of a bundled file', async () => {
    vi.mocked(findSkillFileByPath).mockResolvedValue({
      _id: 'f1', path: 'references/API.md', kind: 'reference', mime: 'text/markdown', bytes: 5, sha256: 'a', contentText: '# API', s3Key: null, executable: false,
    } as never);
    const result = (await (await tools()).readSkillFile.execute({ skill: 'pdf-processing', path: 'references/API.md' })) as Record<string, unknown>;

    expect(result.content).toBe('# API');
  });

  it('refuses a path that is not a file of the skill, and lists the ones that are', async () => {
    vi.mocked(findSkillFileByPath).mockResolvedValue(null);
    vi.mocked(listVersionFiles).mockResolvedValue([
      { _id: 'f1', path: 'references/API.md', kind: 'reference', mime: 'text/markdown', bytes: 5, sha256: 'a', contentText: '# API', s3Key: null, executable: false },
    ] as never);

    const result = (await (await tools()).readSkillFile.execute({ skill: 'pdf-processing', path: '../../etc/passwd' })) as Record<string, unknown>;

    expect(result.error).toMatch(/is not a file of/);
    expect(result.files).toEqual(['references/API.md']);
  });

  it('does not hand back binary content as a wall of bytes', async () => {
    vi.mocked(findSkillFileByPath).mockResolvedValue({
      _id: 'f2', path: 'assets/logo.png', kind: 'asset', mime: 'image/png', bytes: 900, sha256: 'b', contentText: null, s3Key: 'k', executable: false,
    } as never);

    const result = (await (await tools()).readSkillFile.execute({ skill: 'pdf-processing', path: 'assets/logo.png' })) as Record<string, unknown>;

    expect(result.content).toBeUndefined();
    expect(result.error).toMatch(/not text/);
  });

  it('refuses a skill outside the candidate set', async () => {
    const result = (await (await tools()).readSkillFile.execute({ skill: 'not-mine', path: 'x.md' })) as Record<string, unknown>;
    expect(result.error).toMatch(/No skill named/);
    expect(vi.mocked(findSkillFileByPath)).not.toHaveBeenCalled();
  });
});

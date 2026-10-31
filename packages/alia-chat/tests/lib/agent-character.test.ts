import { describe, expect, it, vi } from 'vitest';

vi.mock('@oxy.so/bloom/agent-avatar', () => ({
  parseAvatarCharacter: (value: unknown) => {
    if (!value || typeof value !== 'object' || (value as { shape?: string }).shape === 'unknown')
      throw new Error('Invalid avatar character.');
    return value;
  },
}));

import { DEFAULT_AGENT_CHARACTER, readAgentCharacter } from '../../src/lib/agent-character';
import {
  ALIA_CHARACTER_RUNTIME_URL as entryUrl,
  DEFAULT_AGENT_CHARACTER as entryDefault,
  readAgentCharacter as entryParser,
} from '../../src/character';
import { ALIA_CHARACTER_RUNTIME_URL } from '../../src/lib/character-runtime';

describe('readAgentCharacter', () => {
  it('exposes the same character parser and default runtime URL on the character entry', () => {
    expect(entryParser).toBe(readAgentCharacter);
    expect(entryDefault).toBe(DEFAULT_AGENT_CHARACTER);
    expect(entryUrl).toBe(ALIA_CHARACTER_RUNTIME_URL);
  });
  it('draws a stored character Bloom can parse as it is', () => {
    const stored = {
      shape: 'heart',
      eyes: 'oval',
      eyewear: 'none',
      accessory: 'bow',
      color: 'pink',
    };
    expect(readAgentCharacter(stored)).toEqual(stored);
  });

  it('falls back on the one default look for what is absent or cannot be drawn', () => {
    expect(readAgentCharacter(undefined)).toBe(DEFAULT_AGENT_CHARACTER);
    expect(readAgentCharacter(null)).toBe(DEFAULT_AGENT_CHARACTER);
    expect(readAgentCharacter('teal')).toBe(DEFAULT_AGENT_CHARACTER);
    expect(readAgentCharacter({ shape: 'unknown', color: 'teal' })).toBe(DEFAULT_AGENT_CHARACTER);
  });
});

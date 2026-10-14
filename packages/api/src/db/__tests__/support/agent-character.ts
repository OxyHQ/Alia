import type { AgentCharacter } from '../../../domain/agent-character';

/** A look for a test agent: every agent has one, and no test is about which. */
export const TEST_CHARACTER: AgentCharacter = {
  shape: 'rounded_cube',
  eyes: 'oval',
  eyewear: 'none',
  accessory: 'none',
  color: 'teal',
};

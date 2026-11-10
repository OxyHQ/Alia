import { describe, expect, it } from 'vitest';
import { stepBudget } from '../model-config.js';

const step = (...names: string[]) => ({ toolCalls: names.map((toolName) => ({ toolName })) });
const stops = (steps: ReturnType<typeof step>[], max: number) => stepBudget(max)({ steps } as never);

describe('stepBudget', () => {
  it('counts a step of work', async () => {
    expect(await stops([step('a'), step('a')], 3)).toBe(false);
    expect(await stops([step('a'), step('a'), step('a')], 3)).toBe(true);
  });

  it('does not count a step that only loads tools', async () => {
    const steps = [step('loadTools'), step('a'), step('loadTools'), step('a'), step('a')];
    expect(await stops(steps, 3)).toBe(true);
    expect(await stops(steps.slice(0, 4), 3)).toBe(false);
  });

  it('counts a step that loads tools and does work', async () => {
    expect(await stops([step('loadTools', 'a'), step('a')], 2)).toBe(true);
  });

  it('still bounds a model that only loads', async () => {
    expect(await stops([step('loadTools'), step('loadTools')], 2)).toBe(true);
  });
});

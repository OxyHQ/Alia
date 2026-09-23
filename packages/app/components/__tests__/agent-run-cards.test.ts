import { describe, expect, it, vi } from 'vitest';

/**
 * The pieces of the agent run cards that are Alia's rather than Bloom's: the
 * clock, and the plan's lines as `AgentProgress` steps (which are also its
 * React keys). Plus the one fact the chat relies on to mount a run's card at
 * all: which conversation opened it.
 */

vi.mock('@/components/workspace-browser', () => ({ WorkspaceBrowser: () => null }));
vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable' }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
for (const mod of [
  'accordion',
  'admonition',
  'agent-progress',
  'agent-thinking',
  'badge',
  'card',
  'item',
  'typography',
  'icons/RiAlertLine',
  'icons/RiCheckboxCircleLine',
  'icons/RiCloseCircleLine',
]) {
  const name = mod.startsWith('icons/') ? mod.slice('icons/'.length) : null;
  vi.doMock(`@oxy.so/bloom/${mod}`, () => (name ? { [name]: () => null } : {}));
}
vi.mock('@/lib/hooks/use-translation', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@/lib/task-utils', () => ({ getToolPillLabel: (name: string) => name }));

const { formatRunElapsed, uniqueStepLabels } = await import('@/components/agent-task-card');
const { formatRunDuration } = await import('@/components/agent-result-card');

describe('the run clock', () => {
  it('reads seconds, then minutes and seconds', () => {
    expect(formatRunElapsed(1_000, 43_000)).toBe('42s');
    expect(formatRunElapsed(0, 1)).toBe('');
    expect(formatRunElapsed(1_000, 186_000)).toBe('3m 5s');
  });

  it('reads hours on a long run, and nothing before it started', () => {
    expect(formatRunDuration(null, 5)).toBe('--');
    expect(formatRunDuration(0 + 1, 3_721_001)).toBe('1h 2m');
  });
});

describe('the plan as steps', () => {
  it('keeps a repeated line, told apart by its count, so no step is dropped', () => {
    expect(uniqueStepLabels(['Run the tests', 'Fix', 'Run the tests'])).toEqual([
      'Run the tests',
      'Fix',
      'Run the tests (2)',
    ]);
  });
});

import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/** An agent's row picture is alive and replays its reaction each time its row is pressed. */

const seen: Record<string, unknown>[] = [];
vi.mock('@oxy.so/bloom/agent-avatar', () => ({
  AgentAvatar: (props: Record<string, unknown>) => {
    seen.push(props);
    return null;
  },
}));

import { AgentRowAvatar, reactAgentRow } from '@/shell/agent-row-avatar';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('an agent row’s avatar', () => {
  it('is a live, interactive avatar, never the still portrait', () => {
    act(() => {
      create(<AgentRowAvatar agentId="a1" character={{ preset: 'blue_beret' }} size={36} />);
    });
    const props = seen.at(-1)!;
    expect(props.interactive).toBe(true);
    expect(props.portrait).toBeUndefined();
    expect(props.size).toBe(36);
    expect(props.reactionKey).toBeUndefined();
  });

  it('replays the reaction when its own row is pressed, and not when another is', () => {
    act(() => {
      create(<AgentRowAvatar agentId="a2" character={{ preset: 'blue_beret' }} size={36} />);
    });
    expect(seen.at(-1)!.reactionKey).toBeUndefined();
    act(() => reactAgentRow('a2'));
    expect(seen.at(-1)!.reactionKey).toBe(1);
    act(() => reactAgentRow('someone-else'));
    expect(seen.at(-1)!.reactionKey).toBe(1);
    act(() => reactAgentRow('a2'));
    expect(seen.at(-1)!.reactionKey).toBe(2);
  });
});

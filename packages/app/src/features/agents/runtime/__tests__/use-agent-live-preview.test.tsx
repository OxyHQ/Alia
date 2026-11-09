import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * An edit of how an agent looks reaches every query that draws it as it is made, before the save.
 */

vi.mock('@alia.onl/sdk/runtime', () => ({
  aliaQueryKeys: { agents: { profile: (id: string) => ['alia', 'agents', 'profile', id] } },
}));

import { useAgentLivePreview } from '@/features/agents/runtime/use-agent-live-preview';
import { queryKeys } from '@/shared/api/query-keys';
import { aliaQueryKeys } from '@alia.onl/sdk/runtime';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const blue = { preset: 'blue_beret' } as never;
const green = { preset: 'lime_frog' } as never;

function setup() {
  const client = new QueryClient();
  client.setQueryData(queryKeys.agents.mine, [
    { _id: 'a1', name: 'Pepe', tagline: 'hi', character: blue },
    { _id: 'a2', name: 'Ana', tagline: 'yo', character: blue },
  ]);
  client.setQueryData(queryKeys.agents.detail('a1'), {
    _id: 'a1',
    name: 'Pepe',
    tagline: 'hi',
    character: blue,
  });
  client.setQueryData(aliaQueryKeys.agents.profile('a1'), {
    id: 'a1',
    name: 'Pepe',
    character: blue,
  });
  let preview!: ReturnType<typeof useAgentLivePreview>;
  const Probe = () => {
    preview = useAgentLivePreview('a1');
    return null;
  };
  act(() => {
    create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  return { client, preview };
}

describe('showing an agent’s look ahead of its save', () => {
  it('writes the new avatar into the sidebar’s list, the detail and the chat header’s profile', () => {
    const { client, preview } = setup();
    act(() => preview.show({ character: green }));
    const mine = client.getQueryData<Array<{ _id: string; character: unknown }>>(
      queryKeys.agents.mine,
    )!;
    expect(mine.find((agent) => agent._id === 'a1')?.character).toEqual(green);
    // Another agent is left alone.
    expect(mine.find((agent) => agent._id === 'a2')?.character).toEqual(blue);
    expect(
      client.getQueryData<{ character: unknown }>(queryKeys.agents.detail('a1'))?.character,
    ).toEqual(green);
    expect(
      client.getQueryData<{ character: unknown }>(aliaQueryKeys.agents.profile('a1'))?.character,
    ).toEqual(green);
  });

  it('changes only what the edit names, and a tagline is not on the profile', () => {
    const { client, preview } = setup();
    act(() => preview.show({ tagline: 'new line' }));
    expect(client.getQueryData<{ tagline: string }>(queryKeys.agents.detail('a1'))?.tagline).toBe(
      'new line',
    );
    expect(client.getQueryData(aliaQueryKeys.agents.profile('a1'))).toEqual({
      id: 'a1',
      name: 'Pepe',
      character: blue,
    });
  });

  it('writes nothing for an agent nobody has loaded', () => {
    const { client, preview } = setup();
    client.clear();
    act(() => preview.show({ name: 'X' }));
    expect(client.getQueryData(queryKeys.agents.mine)).toBeUndefined();
  });

  it('reads the three queries again when the save did not land', () => {
    const { client, preview } = setup();
    act(() => preview.show({ name: 'Draft' }));
    act(() => preview.revert());
    expect(client.getQueryState(queryKeys.agents.mine)?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.agents.detail('a1'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(aliaQueryKeys.agents.profile('a1'))?.isInvalidated).toBe(true);
  });
});

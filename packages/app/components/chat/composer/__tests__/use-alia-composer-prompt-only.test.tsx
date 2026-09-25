import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `promptOnly` — the surfaces whose endpoint reads a prompt string and nothing
 * else (`/agents/generate`, `/skills/generate`, both on the default routing
 * profile) — offers no control whose value that send would ignore: no model
 * picker or effort, no mode selector, no add menu (files, search, skills,
 * connectors), and no attachment props, which is what tells the composer to
 * take no paste or drop and draw no tile.
 */

const addMenu = vi.hoisted(() => ({ options: [] as Array<{ canAttach: boolean }> }));

vi.mock('@/components/chat/composer/add-menu', () => ({
  useComposerAddMenu: (options: { canAttach: boolean }) => {
    addMenu.options.push(options);
    return { groups: [], onSelect: () => {} };
  },
}));
vi.mock('@/components/chat/composer/model-lineup', () => ({
  useComposerLineup: () => ({
    providers: [],
    model: 'm',
    onModelChange: () => {},
    effortLevels: [],
    effort: null,
    onEffortChange: () => {},
  }),
}));
vi.mock('@/lib/chat/use-capability-modes', () => ({
  useCapabilityModes: () => ({ active: { ghost: false, agent: false, deepResearch: false }, toggle: () => {} }),
}));
vi.mock('@/lib/hooks/use-mcp-servers', () => ({ useMcpServers: () => ({ installed: [] }) }));
vi.mock('@/lib/hooks/use-skills', () => ({ useInstalledSkills: () => ({ data: [] }) }));
vi.mock('@/lib/hooks/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/stores/model-store', () => {
  const state = { selectedModel: 'm', setSelectedModel: () => {}, webSearch: false, setWebSearch: () => {} };
  return { useModelStore: (selector: (s: typeof state) => unknown) => selector(state) };
});
vi.mock('@/lib/stores/ui-store', () => ({ useUIStore: { getState: () => ({ setRightPanel: () => {} }) } }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { info: () => {} } }));
vi.mock('@oxy.so/bloom/icons/RiChat3Line', () => ({ RiChat3Line: () => null }));
vi.mock('@oxy.so/bloom/icons/RiRobot2Line', () => ({ RiRobot2Line: () => null }));
vi.mock('@oxy.so/bloom/icons/RiSearchLine', () => ({ RiSearchLine: () => null }));

import { useAliaComposer, type AliaComposerOptions } from '../use-alia-composer';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function render(options: AliaComposerOptions) {
  let result: ReturnType<typeof useAliaComposer> | null = null;
  function Probe() {
    result = useAliaComposer(options);
    return null;
  }
  act(() => {
    create(<Probe />);
  });
  return result!;
}

beforeEach(() => {
  addMenu.options = [];
});

describe('a surface that sends a whole turn', () => {
  it('offers every control and hands the composer its list', () => {
    const { props } = render({ draft: 'surface:automations' });

    expect(addMenu.options[0]?.canAttach).toBe(true);
    expect(props.onAddAttachment).toBeTypeOf('function');
    expect(props.attachments).toEqual([]);
    expect(props.providers).toBeDefined();
    expect(props.modes).toHaveLength(3);
    expect(props.addMenu).toBeDefined();
  });
});

describe('a surface that sends only a prompt', () => {
  it('offers no control the prompt would not carry', () => {
    const { props } = render({ draft: 'surface:skill-create', promptOnly: true });

    // Nothing at all: Bloom's panel hides the picker without `providers`, and
    // the composer defaults the add menu and the modes to `[]`, which hide them.
    expect(props).toEqual({});
  });
});

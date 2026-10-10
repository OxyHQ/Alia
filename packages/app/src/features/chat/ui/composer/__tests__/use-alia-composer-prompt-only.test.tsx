import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `promptOnly` — the surfaces whose endpoint reads a prompt string and nothing
 * else (`/agents/generate`, `/skills/generate`) — offers no control whose value
 * that send would ignore: no add menu (files, search, skills, connectors), and
 * no attachment props, which is what tells the composer to take no paste or
 * drop and draw no tile. The power-level selector stays only where the screen
 * keeps its own level: creating an agent stores the one picked as the new
 * agent's level.
 */

const addMenu = vi.hoisted(() => ({ options: [] as Array<{ canAttach: boolean }> }));

vi.mock('@/features/chat/ui/composer/add-menu', () => ({
  useComposerAddMenu: (options: { canAttach: boolean }) => {
    addMenu.options.push(options);
    return { groups: [], onSelect: () => {} };
  },
}));
const levels = vi.hoisted(() => ({ calls: [] as Array<{ devices?: boolean }> }));
vi.mock('@/features/chat/ui/composer/power-level-options', () => ({
  usePowerLevelSelector: (
    _stored: unknown,
    _onChange: unknown,
    options: { devices?: boolean } = {},
  ) => {
    levels.calls.push(options);
    return {
      modes: ['auto', 'instant', 'medium', 'high', 'xhigh', 'pro', 'ultra'].map((id) => ({
        id,
        label: id,
        description: id,
        icon: () => null,
      })),
      mode: 'auto',
      onModeChange: () => {},
    };
  },
}));
vi.mock('@/features/chat/runtime/use-capability-modes', () => ({
  useCapabilityModes: () => ({
    active: { ghost: false, agent: false, deepResearch: false },
    toggle: () => {},
  }),
}));
vi.mock('@/features/connections/runtime/use-mcp-servers', () => ({
  useMcpServers: () => ({ installed: [] }),
}));
vi.mock('@/features/skills/runtime/use-skills', () => ({
  useInstalledSkills: () => ({ data: [] }),
}));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/features/chat/runtime/model-store', () => {
  const state = {
    selectedModel: 'm',
    setSelectedModel: () => {},
    webSearch: false,
    setWebSearch: () => {},
  };
  return { useModelStore: (selector: (s: typeof state) => unknown) => selector(state) };
});
vi.mock('@/features/chat/runtime/ui-store', () => ({
  useUIStore: { getState: () => ({ setRightPanel: () => {} }) },
}));
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
  levels.calls = [];
});

describe('a surface that sends a whole turn', () => {
  it('offers every control and hands the composer its list', () => {
    const { props } = render({ draft: 'surface:automations' });

    expect(addMenu.options[0]?.canAttach).toBe(true);
    expect(props.onAddAttachment).toBeTypeOf('function');
    expect(props.attachments).toEqual([]);
    // The mode pill is the power level: the seven levels, and no model picker.
    expect(props.modes?.map((mode) => mode.id)).toEqual([
      'auto',
      'instant',
      'medium',
      'high',
      'xhigh',
      'pro',
      'ultra',
    ]);
    expect(props.mode).toBe('auto');
    expect(props).not.toHaveProperty('providers');
    // The person's own device models are offered where a turn can run on them.
    expect(levels.calls[0]).toEqual({ devices: true });
    expect(props.addMenu).toBeDefined();
  });
});

describe('a surface that sends only a prompt', () => {
  it('offers no control the prompt would not carry', () => {
    const { props } = render({ draft: 'surface:skill-create', promptOnly: true });

    // Nothing at all: the composer defaults the add menu and the modes to `[]`,
    // which hide them.
    expect(props).toEqual({});
  });

  it('keeps the power-level selector, and only it, where the screen keeps its own level', () => {
    const onModelChange = vi.fn();
    const { props } = render({
      draft: 'surface:agent-create',
      promptOnly: true,
      selectedModel: null,
      onModelChange,
    });

    expect(Object.keys(props).sort()).toEqual(['mode', 'modes', 'onModeChange']);
    // A new agent runs in Alia, never on this person's device.
    expect(levels.calls[0]).toEqual({ devices: false });
  });
});

import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `attach: false` — the surfaces whose backend reads a prompt string and
 * nothing else (create-agent, create-skill) — offers no way to attach: no
 * picker rows, and no attachment props, which is what tells the composer to
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

describe('a surface that takes files', () => {
  it('offers the picker rows and hands the composer its list', () => {
    const { props } = render({ draft: 'surface:automations' });

    expect(addMenu.options[0]?.canAttach).toBe(true);
    expect(props.onAddAttachment).toBeTypeOf('function');
    expect(props.attachments).toEqual([]);
  });
});

describe('a surface that sends only a prompt', () => {
  it('offers no picker rows and no attachment props at all', () => {
    const { props } = render({ draft: 'surface:skill-create', attach: false });

    expect(addMenu.options[0]?.canAttach).toBe(false);
    expect('attachments' in props).toBe(false);
    expect('onAddAttachment' in props).toBe(false);
    expect('onRemoveAttachment' in props).toBe(false);
  });
});

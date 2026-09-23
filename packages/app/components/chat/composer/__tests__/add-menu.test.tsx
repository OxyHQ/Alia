import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComposerPanelAddMenuGroup } from '@oxy.so/bloom/composer-panel';

/**
 * The capability menu, as the data Bloom draws it from.
 *
 * ## What this is guarding
 *
 * Seven of the composer's rows are SWITCHES — web search, deep research,
 * ghost, agent, every installed skill and every connected app — and the
 * composer is where their state is read. Bloom's `AddMenu` draws a tick from
 * `ComposerPanelAddMenuRow.checked` and nothing else, so a row that forgets to
 * carry it is a switch with no visible state: identical whether it turned
 * something on or off, which is the failure the first attempt at this adoption
 * refused to ship. This file is what says every switch carries one and the
 * action rows carry none.
 *
 * The second half is the routing. The rows used to be components that closed
 * over their own handler; they are ids now, and `onSelect` is one switch
 * statement — so "the ghost row toggles ghost" stopped being obvious from
 * reading the markup and became something worth pinning.
 */

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const pickers = vi.hoisted(() => ({
  pickImage: vi.fn(async () => []),
  takePhoto: vi.fn(async () => []),
  pickDocument: vi.fn(async () => []),
}));

vi.mock('@/lib/hooks/use-image-picker', () => ({
  useImagePicker: () => ({ pickImage: pickers.pickImage, takePhoto: pickers.takePhoto }),
}));
vi.mock('@/lib/hooks/use-document-picker', () => ({
  useDocumentPicker: () => ({ pickDocument: pickers.pickDocument }),
}));

/**
 * Bloom's icons, one specifier at a time — and NOT because a stub is
 * preferable here.
 *
 * `vitest.config.ts` inlines `@oxy.so/bloom` so a real Bloom component can be
 * mounted, and it works for every literal subpath in the package;
 * `composer-keys.test.tsx` next door mounts the real `ComposerPill` through
 * it. It does not work for `./icons/Ri*`, which is a WILDCARD export: vite
 * externalises the specifier before the inline pattern is consulted, node then
 * resolves the `react-native` condition to the raw `src/icons/remix/*.tsx`,
 * and the suite dies at import with `SyntaxError: Unexpected token 'typeof'`
 * before a single test runs. Every icon the menu names is listed here for that
 * reason and no other. What is under test is a list of rows; the artwork on
 * them is Bloom's business.
 *
 * Spelt out one call at a time because `vi.mock` is hoisted to the top of the
 * module: a loop or a helper around it reads as ten calls and runs as a
 * `ReferenceError` before any of them.
 */
const icon = vi.hoisted(() => (name: string) => async () => {
  const ReactModule = await import('react');
  return { [name]: (props: Record<string, unknown>) => ReactModule.createElement(name, props) };
});

vi.mock('@oxy.so/bloom/icons/RiCameraLine', icon('RiCameraLine'));
vi.mock('@oxy.so/bloom/icons/RiImageLine', icon('RiImageLine'));
vi.mock('@oxy.so/bloom/icons/RiAttachment2', icon('RiAttachment2'));
vi.mock('@oxy.so/bloom/icons/RiEarthLine', icon('RiEarthLine'));
vi.mock('@oxy.so/bloom/icons/RiSearchLine', icon('RiSearchLine'));
vi.mock('@oxy.so/bloom/icons/RiEyeOffLine', icon('RiEyeOffLine'));
vi.mock('@oxy.so/bloom/icons/RiRobot2Line', icon('RiRobot2Line'));
vi.mock('@oxy.so/bloom/icons/RiPencilLine', icon('RiPencilLine'));
vi.mock('@oxy.so/bloom/icons/RiBookOpenLine', icon('RiBookOpenLine'));
vi.mock('@oxy.so/bloom/icons/RiPlugLine', icon('RiPlugLine'));

vi.mock('expo-image', async () => {
  const ReactModule = await import('react');
  return { Image: (props: Record<string, unknown>) => ReactModule.createElement('Image', props) };
});
vi.mock('@/components/ui/action-key-icon', async () => {
  const ReactModule = await import('react');
  return { ActionKeyIcon: (props: Record<string, unknown>) => ReactModule.createElement('ActionKeyIcon', props) };
});

import { useComposerAddMenu, type ComposerAddMenuOptions } from '../add-menu';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.clearAllMocks();
});

const EMPTY_SELECTION = { skills: [], connectors: [] };

function base(over: Partial<ComposerAddMenuOptions> = {}): ComposerAddMenuOptions {
  return {
    addAttachment: vi.fn(),
    canAttach: true,
    modes: { ghost: false, agent: false, deepResearch: false },
    toggleMode: vi.fn(),
    webSearch: false,
    onToggleWebSearch: vi.fn(),
    onOpenCanvas: vi.fn(),
    offerGhost: true,
    turnSelection: EMPTY_SELECTION,
    onToggleSkill: vi.fn(),
    onToggleConnector: vi.fn(),
    ...over,
  };
}

/**
 * The hook, run in a component that renders nothing.
 *
 * A hook is what this is — the groups and the handler are values, not a tree —
 * so there is nothing to mount and nothing to query. What comes back is the
 * two things the composer hands Bloom.
 */
function run(options: ComposerAddMenuOptions) {
  let menu!: ReturnType<typeof useComposerAddMenu>;
  function Probe() {
    menu = useComposerAddMenu(options);
    return null;
  }
  act(() => {
    renderer = create(<Probe />);
  });
  return menu;
}

function rows(groups: readonly ComposerPanelAddMenuGroup[]) {
  return groups.flatMap((group) => group.rows);
}

function row(groups: readonly ComposerPanelAddMenuGroup[], id: string) {
  const found = rows(groups).find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
}

describe('every switch says which way it is', () => {
  it('ticks a capability that is on and holds the space for one that is not', () => {
    const on = run(base({ webSearch: true, modes: { ghost: true, agent: false, deepResearch: false } }));
    expect(row(on.groups, 'cap:web-search').checked).toBe(true);
    expect(row(on.groups, 'cap:ghost').checked).toBe(true);
    // `false`, NOT undefined: the difference is a tick column the row keeps
    // when it is off against a row that never had one.
    expect(row(on.groups, 'cap:agent').checked).toBe(false);
    expect(row(on.groups, 'cap:deep-research').checked).toBe(false);
  });

  it('gives canvas no tick column at all, because it is not on or off', () => {
    const menu = run(base());
    expect(row(menu.groups, 'cap:canvas').checked).toBeUndefined();
    for (const id of ['add:camera', 'add:photos', 'add:files']) {
      expect(row(menu.groups, id).checked).toBeUndefined();
    }
  });

  it('carries a skill’s and an app’s own selection', () => {
    const menu = run(
      base({
        turnSelection: {
          skills: [
            { id: 's1', name: 'research', label: 'Research', description: 'reads', selected: true },
            { id: 's2', name: 'draw', label: 'Draw', description: 'draws', selected: false },
          ],
          connectors: [
            { id: 'c1', label: 'Calendar', icon: undefined, toolCount: 3, selected: true },
          ],
        },
      }),
    );
    expect(row(menu.groups, 'skill:research').checked).toBe(true);
    expect(row(menu.groups, 'skill:draw').checked).toBe(false);
    expect(row(menu.groups, 'connector:c1').checked).toBe(true);
  });
});

describe('the groups appear on their own terms', () => {
  it('shows skills without a connector, and a connector without skills', () => {
    // The old menu nested the skills block inside the connectors' condition,
    // so an account with skills and no running MCP server was shown none of
    // them. Two independent pushes is what stops that from coming back.
    const skillsOnly = run(
      base({
        turnSelection: {
          skills: [{ id: 's1', name: 'research', label: 'Research', description: '', selected: false }],
          connectors: [],
        },
      }),
    );
    expect(skillsOnly.groups.map((group) => group.label)).toContain('skills.composerLabel');
    expect(skillsOnly.groups.map((group) => group.label)).not.toContain('composer.appsGroup');

    const appsOnly = run(
      base({
        turnSelection: {
          skills: [],
          connectors: [{ id: 'c1', label: 'Calendar', icon: undefined, toolCount: 1, selected: false }],
        },
      }),
    );
    expect(appsOnly.groups.map((group) => group.label)).toContain('composer.appsGroup');
    expect(appsOnly.groups.map((group) => group.label)).not.toContain('skills.composerLabel');
  });

  it('withholds ghost once the conversation has something in it', () => {
    const fresh = run(base({ offerGhost: true }));
    expect(rows(fresh.groups).map((r) => r.id)).toContain('cap:ghost');
    const ongoing = run(base({ offerGhost: false }));
    expect(rows(ongoing.groups).map((r) => r.id)).not.toContain('cap:ghost');
  });

  it('gives every group a distinct label, because Bloom keys them by it', () => {
    const menu = run(
      base({
        turnSelection: {
          skills: [{ id: 's1', name: 'a', label: 'A', description: '', selected: false }],
          connectors: [{ id: 'c1', label: 'B', icon: undefined, toolCount: 1, selected: false }],
        },
      }),
    );
    const labels = menu.groups.map((group) => group.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((label) => label.length > 0)).toBe(true);
  });

  it('gives every row a distinct id, because that id is the whole message', () => {
    const menu = run(
      base({
        turnSelection: {
          skills: [{ id: 's1', name: 'canvas', label: 'Canvas skill', description: '', selected: false }],
          connectors: [{ id: 'canvas', label: 'Canvas app', icon: undefined, toolCount: 1, selected: false }],
        },
      }),
    );
    // Deliberately adversarial: a skill and an app both called `canvas`, next
    // to the action row of the same name. The namespaces are what keep the
    // three apart, and `onSelect` has nothing else to go on.
    const ids = rows(menu.groups).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('a press reaches the thing it names', () => {
  it('routes each capability row to its own toggle', () => {
    const options = base();
    const menu = run(options);

    menu.onSelect('cap:web-search');
    expect(options.onToggleWebSearch).toHaveBeenCalledTimes(1);

    menu.onSelect('cap:deep-research');
    expect(options.toggleMode).toHaveBeenLastCalledWith('deepResearch');
    menu.onSelect('cap:ghost');
    expect(options.toggleMode).toHaveBeenLastCalledWith('ghost');
    menu.onSelect('cap:agent');
    expect(options.toggleMode).toHaveBeenLastCalledWith('agent');

    menu.onSelect('cap:canvas');
    expect(options.onOpenCanvas).toHaveBeenCalledTimes(1);
  });

  it('routes a skill and an app by the part of the id that is theirs', () => {
    const options = base({
      turnSelection: {
        skills: [{ id: 's1', name: 'deep:research', label: 'R', description: '', selected: false }],
        connectors: [{ id: 'c:1', label: 'C', icon: undefined, toolCount: 1, selected: false }],
      },
    });
    const menu = run(options);
    // Names and ids with colons in them: the prefix is stripped once, and the
    // rest is handed over whole.
    menu.onSelect('skill:deep:research');
    expect(options.onToggleSkill).toHaveBeenCalledWith('deep:research');
    menu.onSelect('connector:c:1');
    expect(options.onToggleConnector).toHaveBeenCalledWith('c:1');
  });

  it('withholds the pickers while nothing can be attached, and refuses one anyway', () => {
    // The rows go while a turn streams or the limit is on — but `onSelect` is
    // asked again, because a menu left open across the start of a stream is
    // pressed a moment later, and that press reaches a list this build has
    // stopped drawing.
    const options = base({ canAttach: false });
    const menu = run(options);
    const ids = rows(menu.groups).map((r) => r.id);
    expect(ids).not.toContain('add:camera');
    expect(ids).not.toContain('add:photos');
    expect(ids).not.toContain('add:files');

    menu.onSelect('add:photos');
    expect(pickers.pickImage).not.toHaveBeenCalled();
  });

  it('keeps the capability toggles reachable while a turn streams', () => {
    // Narrower than the lock it replaces, and deliberately: a toggle applies
    // to the NEXT turn, so changing one mid-answer is harmless. The old menu
    // took them away only because a dropdown has one trigger to disable, and
    // the model chip beside it was already exempt on exactly that reasoning.
    const options = base({ canAttach: false });
    const menu = run(options);
    expect(rows(menu.groups).map((r) => r.id)).toContain('cap:web-search');
    menu.onSelect('cap:web-search');
    expect(options.onToggleWebSearch).toHaveBeenCalledTimes(1);
  });

  it('opens the picker each add row names', () => {
    const menu = run(base());
    menu.onSelect('add:camera');
    expect(pickers.takePhoto).toHaveBeenCalledTimes(1);
    menu.onSelect('add:photos');
    expect(pickers.pickImage).toHaveBeenCalledTimes(1);
    menu.onSelect('add:files');
    expect(pickers.pickDocument).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a row this build did not produce', () => {
    const options = base();
    const menu = run(options);
    menu.onSelect('cap:shopping-research');
    expect(options.toggleMode).not.toHaveBeenCalled();
    expect(options.onOpenCanvas).not.toHaveBeenCalled();
    expect(pickers.pickImage).not.toHaveBeenCalled();
  });
});

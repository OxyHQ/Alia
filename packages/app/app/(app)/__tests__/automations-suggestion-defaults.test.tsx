import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What the create dialog opens WITH (#533, #535, #536).
 *
 * The bug was not in any one field: name and prompt were reset on every open,
 * the schedule never, so a card that said "every hour" opened daily at 06:00
 * PM — or at whatever time the previous dialog had been left with. The
 * assertions here are therefore on the dialog's fields AFTER an earlier dialog
 * was edited and cancelled, which is the sequence a person actually performs.
 */

const mutateAsync = vi.hoisted(() => vi.fn<(input: unknown) => Promise<void>>(async () => undefined));
const toastCalls = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const push = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web },
    View: host('View'),
    ScrollView: host('ScrollView'),
    Pressable: host('Pressable'),
  };
});
vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});
vi.mock('@/components/ui/button', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Button', props, children),
  };
});
vi.mock('@/components/ui/input', async () => {
  const ReactModule = await import('react');
  return { Input: (props: Record<string, unknown>) => ReactModule.createElement('Input', props) };
});
vi.mock('@/components/ui/textarea', async () => {
  const ReactModule = await import('react');
  return { Textarea: (props: Record<string, unknown>) => ReactModule.createElement('Textarea', props) };
});
vi.mock('@/components/ui/label', async () => {
  const ReactModule = await import('react');
  return {
    Label: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Label', props, children),
  };
});
vi.mock('@/components/ui/toggle-group', async () => {
  const ReactModule = await import('react');
  return {
    ToggleGroup: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('ToggleGroup', props, children),
    ToggleGroupItem: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('ToggleGroupItem', props, children),
  };
});
vi.mock('@/components/ui/drawer-toggle', async () => {
  const ReactModule = await import('react');
  return { DrawerToggle: (props: Record<string, unknown>) => ReactModule.createElement('DrawerToggle', props) };
});
/** The dialog keeps its props on a host element so the test can cancel it. */
vi.mock('@oxy.so/bloom/dialog', async () => {
  const ReactModule = await import('react');
  return {
    Dialog: ({ children, ...props }: React.PropsWithChildren<{ open?: boolean }>) =>
      ReactModule.createElement('Dialog', props, props.open === true ? children : null),
  };
});
vi.mock('@oxy.so/bloom/toast', () => ({ toast: toastCalls }));
vi.mock('@oxy.so/bloom/content-panel', async () => {
  const ReactModule = await import('react');
  return {
    ContentPanel: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('ContentPanel', props, children),
  };
});
vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  const glyph = (props: Record<string, unknown>) => ReactModule.createElement('Glyph', props);
  return { CloudCog: glyph, Plus: glyph };
});
vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { mutedForeground: 'rgb(113 113 122)' } }),
}));
vi.mock('@/lib/hooks/use-translation', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t, locale: 'en', changeLocale: () => undefined }) };
});
vi.mock('@/lib/errors/error-utils', () => ({
  errorMessage: (_error: unknown, fallback: string) => fallback,
}));
vi.mock('@/lib/hooks/use-automations', () => ({
  useCreateLegacyAutomation: () => ({ mutateAsync, isPending: false }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push, back: vi.fn() }) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { default: AutomationsScreen } = await import('../automations');

const HOURLY = 'Review PR comments every hour and share next steps';
const MONDAY = "Summarize my team's PRs from last week every Monday morning";
const EVENING = "Add tests every evening for today's code changes";

let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.clearAllMocks();
});

function mount(): ReactTestInstance {
  act(() => {
    renderer = create(React.createElement(AutomationsScreen));
  });
  return renderer.root;
}

/** Host element names, as the mocks above register them. */
const typeName = (node: ReactTestInstance): string => String(node.type);

function byLabel(root: ReactTestInstance, type: string, label: string): ReactTestInstance {
  const matches = root.findAll((node) => typeName(node) === type && node.props.accessibilityLabel === label);
  if (matches.length !== 1) throw new Error(`${matches.length} ${type} elements labelled "${label}"`);
  return matches[0] as ReactTestInstance;
}

function press(node: ReactTestInstance): void {
  act(() => {
    (node.props.onPress as () => void)();
  });
}

function dialog(root: ReactTestInstance): ReactTestInstance {
  return root.findByType('Dialog' as unknown as React.ElementType);
}

/** The dialog's fields, read the way a person sees them. */
function fields(root: ReactTestInstance) {
  const scheduleType = root.findByType('ToggleGroup' as unknown as React.ElementType).props.value as string;
  const prompt = byLabel(root, 'Textarea', 'automations.prompt').props.value as string;
  const name = byLabel(root, 'Input', 'automations.name').props.value as string;
  if (scheduleType === 'interval') {
    return { name, prompt, scheduleType, intervalMinutes: byLabel(root, 'Input', 'Interval minutes').props.value as string };
  }
  const time = byLabel(root, 'Input', 'Schedule time').props.value as string;
  const days = root
    .findAll((node) => typeName(node) === 'Pressable' && typeof node.props.accessibilityState?.selected === 'boolean')
    .map((node) => [node.props.accessibilityLabel as string, node.props.accessibilityState.selected as boolean] as const);
  return { name, prompt, scheduleType, time, selectedDays: days.filter(([, selected]) => selected).map(([day]) => day) };
}

describe('automation suggestions open with their advertised schedule', () => {
  it('opens "every hour" as a 60 minute interval and "Monday morning" as Monday at 09:00 AM', () => {
    const root = mount();
    expect(dialog(root).props.open).toBe(false);

    press(byLabel(root, 'Pressable', HOURLY));
    expect(fields(root)).toEqual({ name: '', prompt: HOURLY, scheduleType: 'interval', intervalMinutes: '60' });

    act(() => dialog(root).props.onClose());
    press(byLabel(root, 'Pressable', MONDAY));
    expect(fields(root)).toEqual({
      name: '',
      prompt: MONDAY,
      scheduleType: 'daily',
      time: '09:00 AM',
      selectedDays: ['Monday'],
    });
  });

  it('resets every field when a second suggestion is opened after the first was edited and cancelled', () => {
    const root = mount();
    press(byLabel(root, 'Pressable', MONDAY));

    act(() => byLabel(root, 'Input', 'automations.name').props.onChangeText('My PR digest'));
    act(() => byLabel(root, 'Input', 'Schedule time').props.onChangeText('11:45 AM'));
    press(byLabel(root, 'Pressable', 'Friday'));
    act(() => root.findByType('ToggleGroup' as unknown as React.ElementType).props.onValueChange('interval'));
    act(() => byLabel(root, 'Input', 'Interval minutes').props.onChangeText('5'));
    expect(fields(root)).toMatchObject({ name: 'My PR digest', scheduleType: 'interval', intervalMinutes: '5' });

    act(() => dialog(root).props.onClose());
    expect(dialog(root).props.open).toBe(false);

    press(byLabel(root, 'Pressable', EVENING));
    expect(fields(root)).toEqual({
      name: '',
      prompt: EVENING,
      scheduleType: 'daily',
      time: '06:00 PM',
      selectedDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    });
  });

  it('opens the plain "+" flow from the base defaults, under an accessible name', () => {
    const root = mount();
    press(byLabel(root, 'Pressable', HOURLY));
    act(() => dialog(root).props.onClose());

    const create = byLabel(root, 'Button', 'automations.createAutomation');
    expect(create.props.accessibilityRole).toBe('button');
    press(create);
    expect(fields(root)).toEqual({
      name: '',
      prompt: '',
      scheduleType: 'daily',
      time: '06:00 PM',
      selectedDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    });
  });

  it('sends the interval the suggestion carries, not a hard-coded hour', async () => {
    const root = mount();
    press(byLabel(root, 'Pressable', HOURLY));
    act(() => byLabel(root, 'Input', 'automations.name').props.onChangeText('PR watch'));
    act(() => byLabel(root, 'Input', 'Interval minutes').props.onChangeText('30'));

    const createAction = (dialog(root).props.actions as Array<{ onPress?: () => Promise<void> }>)
      .find((action) => typeof action.onPress === 'function');
    await act(async () => {
      await createAction?.onPress?.();
    });

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      name: 'PR watch',
      schedule: { type: 'interval', intervalMinutes: 30 },
    });
    expect(toastCalls.success).toHaveBeenCalledTimes(1);
    const options = toastCalls.success.mock.calls[0]?.[1] as { action?: { onClick: () => void } };
    options.action?.onClick();
    expect(push).toHaveBeenCalledWith('/(app)/tasks');
  });

  it('labels each weekday button with its full name and selection state', () => {
    const root = mount();
    press(byLabel(root, 'Pressable', MONDAY));
    const monday = byLabel(root, 'Pressable', 'Monday');
    const tuesday = byLabel(root, 'Pressable', 'Tuesday');
    expect(monday.props.accessibilityRole).toBe('button');
    expect(monday.props.accessibilityState).toEqual({ selected: true });
    expect(tuesday.props.accessibilityState).toEqual({ selected: false });
    press(tuesday);
    expect(byLabel(root, 'Pressable', 'Tuesday').props.accessibilityState).toEqual({ selected: true });
  });
});

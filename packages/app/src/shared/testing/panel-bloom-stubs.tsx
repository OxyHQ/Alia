import React, { createContext, useContext } from 'react';

/**
 * Bloom stubbed at its module boundary for the right-panel suites.
 *
 * The panels are built from Bloom (`Item`, `Accordion`, the agent log,
 * `EmptyState`, `CodeBlock`…), and these suites are about what the panels
 * decide — which rows exist, what they say, which are controls, what a press
 * does — not about how Bloom draws them. Each stub is a host element named
 * after the component and carrying its props, plus the one behaviour a panel
 * leans on (an `Item` with `onPress` is a button; an accordion section opens
 * and closes), so a query reads the panel's decisions straight off the tree.
 *
 * Used from `vi.mock` factories via `await import('./panel-bloom-stubs')`.
 */

type Props = React.PropsWithChildren<Record<string, unknown>>;

export const host =
  (name: string) =>
  ({ children, ...props }: Props) =>
    React.createElement(name, props, children as React.ReactNode);

/** `{ [name]: host(name) }` for an icon module. */
export const iconModule = (name: string) => ({ [name]: host(name) });

export const itemModule = () => ({
  Item: ({ title, subtitle, leading, trailing, onPress, accessibilityLabel, expanded, children, ...rest }: Props) =>
    React.createElement(
      onPress === undefined ? 'View' : 'Pressable',
      {
        ...rest,
        accessible: true,
        accessibilityLabel,
        accessibilityRole: onPress === undefined ? undefined : 'button',
        accessibilityState: expanded === undefined ? undefined : { expanded },
        onPress,
      },
      leading as React.ReactNode,
      title === undefined ? null : React.createElement('Text', { numberOfLines: 1 }, title as React.ReactNode),
      subtitle === undefined ? null : React.createElement('Text', { numberOfLines: 2 }, subtitle as React.ReactNode),
      children as React.ReactNode,
      trailing as React.ReactNode,
    ),
});

const AccordionCtx = createContext<{ open: string[]; toggle: (v: string) => void }>({ open: [], toggle: () => {} });
const ItemCtx = createContext('');

export const accordionModule = () => ({
  Accordion: ({ value, onValueChange, children }: Props) => {
    const open = Array.isArray(value) ? (value as string[]) : typeof value === 'string' ? [value] : [];
    const toggle = (v: string) =>
      (onValueChange as (next: string[]) => void)(open.includes(v) ? open.filter((x) => x !== v) : [...open, v]);
    return React.createElement(AccordionCtx.Provider, { value: { open, toggle } }, children as React.ReactNode);
  },
  AccordionItem: ({ value, children }: Props) =>
    React.createElement(ItemCtx.Provider, { value: value as string }, children as React.ReactNode),
  AccordionTrigger: ({ children }: Props) => {
    const { open, toggle } = useContext(AccordionCtx);
    const value = useContext(ItemCtx);
    return React.createElement(
      'Pressable',
      {
        accessibilityRole: 'button',
        accessibilityLabel: typeof children === 'string' ? children : undefined,
        accessibilityState: { expanded: open.includes(value) },
        onPress: () => toggle(value),
      },
      children as React.ReactNode,
    );
  },
  // The real content stays mounted behind a zero-height clip; a closed section
  // is unmounted here so "is it shown" reads off the tree.
  AccordionContent: ({ children }: Props) => {
    const { open } = useContext(AccordionCtx);
    const value = useContext(ItemCtx);
    return open.includes(value) ? React.createElement('AccordionContent', null, children as React.ReactNode) : null;
  },
});

export const emptyStateModule = () => ({
  EmptyState: ({ title, description, illustration, ...rest }: Props) =>
    React.createElement(
      'EmptyState',
      rest,
      illustration as React.ReactNode,
      title as React.ReactNode,
      description as React.ReactNode,
    ),
});

export const agentLogModule = () => ({
  AgentLogRow: host('AgentLogRow'),
  AgentLogShimmerText: host('AgentLogShimmerText'),
  AgentLogWorkingRow: ({ label, ...rest }: Props) => React.createElement('AgentLogWorkingRow', rest, label as string),
  useAgentLogMotion: () => true,
});

export const typographyModule = () => ({ Text: host('Text'), Muted: host('Text') });

export const themeModule = () => ({
  useTheme: () => ({
    colors: {
      success: 'green',
      warning: 'orange',
      info: 'blue',
      error: 'red',
      primary: 'black',
      text: 'black',
      textSecondary: 'gray',
    },
  }),
});

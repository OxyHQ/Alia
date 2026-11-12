import React from 'react';

/**
 * Bloom stubbed at its module boundary for the right-panel suites.
 *
 * These suites are about what the panels decide — which rows exist, what they
 * say, which are controls, what a press does — not about how Bloom draws them.
 * A stub is a host element named after the component and carrying its props,
 * so a query reads the panel's decisions straight off the tree.
 *
 * Used from `vi.mock` factories via `await import('./panel-bloom-stubs')`.
 */

type Props = React.PropsWithChildren<Record<string, unknown>>;

export const host =
  (name: string) =>
  ({ children, ...props }: Props) =>
    React.createElement(name, props, children as React.ReactNode);

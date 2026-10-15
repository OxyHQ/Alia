import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@oxy.so/bloom/item', () => ({ Item: 'Item' }));
vi.mock('@oxy.so/bloom/typography', () => ({ Muted: 'Muted' }));
vi.mock('@oxy.so/bloom/icons/RiCheckLine', () => ({ RiCheckLine: 'Check' }));
import { AgentTemplatePicker } from '../agent-template-picker';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
describe('editable agent templates', () => {
  it('does nothing until chosen and supplies editable instructions, not grants', () => {
    const choose = vi.fn();
    const mounted: { current?: ReactTestRenderer } = {};
    act(() => {
      mounted.current = create(
        React.createElement(AgentTemplatePicker, { selected: null, onSelect: choose }),
      );
    });
    const view = mounted.current;
    if (!view) throw new Error('Template picker did not mount');
    expect(choose).not.toHaveBeenCalled();
    const options = view.root.findAll((node) => node.type === ('Item' as never));
    expect(options).toHaveLength(2);
    act(() => options[0].props.onPress());
    expect(choose).toHaveBeenLastCalledWith('communication', expect.stringContaining('Schedio'));
    act(() => options[1].props.onPress());
    expect(choose).toHaveBeenLastCalledWith('materials', expect.stringContaining('Mercaria'));
    expect(choose.mock.calls[1]).toHaveLength(2);
    act(() => view.unmount());
  });
});

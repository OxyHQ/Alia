import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({ sticker: undefined as unknown }));
vi.mock('@oxy.so/stickers/react', () => ({ useSticker: () => ({ data: world.sticker }) }));
vi.mock('@oxy.so/bloom/sticker', async () => {
  const ReactModule = await import('react');
  return { Sticker: (props: object) => ReactModule.createElement('Sticker', props) };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    View: (props: object) => ReactModule.createElement('View', props),
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { EmptyStateSticker } = await import('../empty-state-sticker');

const render = () => {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<EmptyStateSticker name="shows" />);
  });
  return renderer.root;
};

describe('EmptyStateSticker', () => {
  it('keeps the slot at its size, empty, until the sticker resolves', () => {
    world.sticker = undefined;
    const root = render();
    expect(root.findAllByType('Sticker' as never)).toHaveLength(0);
    expect(root.findByType('View' as never).props.style).toEqual({ width: 120, height: 120 });
  });

  it('draws the animated sticker over its still, decorative', () => {
    world.sticker = {
      animation: { url: 'https://cdn/a.json' },
      fallback: { url: 'https://cdn/a.webp' },
    };
    const sticker = render().findByType('Sticker' as never);
    expect(sticker.props).toMatchObject({
      animation: 'https://cdn/a.json',
      fallback: 'https://cdn/a.webp',
      size: 120,
      decorative: true,
    });
  });
});

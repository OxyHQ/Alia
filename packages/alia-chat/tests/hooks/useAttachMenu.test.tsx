import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The default attach menu offers what the lead takes (`docs/agent-embedding.md` §5): a row only
 * where the feature is available or locked, and a locked row is the host's upsell, not a picker.
 */

const world = vi.hoisted(() => ({ picked: 0 }));

vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({}) }));
vi.mock('@oxy.so/bloom/icons/RiImageLine', () => ({ RiImageLine: 'image-icon' }));
vi.mock('@oxy.so/bloom/icons/RiFileTextLine', () => ({ RiFileTextLine: 'file-icon' }));
vi.mock('../../src/hooks/useImagePicker', () => ({
  useImagePicker: () => ({
    pickImage: async () => {
      world.picked += 1;
      return [];
    },
  }),
}));

import { type AttachOffers, useAttachMenu } from '../../src/hooks/useAttachMenu';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let menu: ReturnType<typeof useAttachMenu>;
const onFeatureLocked = vi.fn();
function Probe({ offers }: { offers: AttachOffers }) {
  menu = useAttachMenu({ account: 'me', target: null } as never, offers, onFeatureLocked);
  return null;
}
let renderer: ReactTestRenderer | null = null;
async function mount(offers: AttachOffers) {
  await act(async () => {
    renderer = create(<Probe offers={offers} />);
  });
}
const rows = () => menu.groups.flatMap((group) => group.rows.map((row) => row.id));

beforeEach(() => {
  world.picked = 0;
  onFeatureLocked.mockClear();
});
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
});

describe('useAttachMenu', () => {
  it('offers photos and files where the lead takes both', async () => {
    await mount({ images: 'available', documents: 'available' });
    expect(rows()).toEqual(['photos', 'documents']);
    expect(menu.kinds).toEqual(['image', 'document']);
  });

  it('leaves out what the lead does not offer at all', async () => {
    await mount({ images: 'available', documents: 'absent' });
    expect(rows()).toEqual(['photos']);
    expect(menu.kinds).toEqual(['image']);
  });

  it('shows a locked feature, and pressing it is the host’s upsell rather than a picker', async () => {
    await mount({ images: 'locked', documents: 'locked' });
    expect(rows()).toEqual(['photos', 'documents']);
    // Nothing locked is taken by a drop or a paste either.
    expect(menu.kinds).toEqual([]);

    await act(async () => menu.onSelect('photos'));
    await act(async () => menu.onSelect('documents'));
    expect(onFeatureLocked.mock.calls).toEqual([['attachments.images'], ['attachments.documents']]);
    expect(world.picked).toBe(0);
  });

  it('has no menu at all for a lead that takes nothing', async () => {
    await mount({ images: 'absent', documents: 'absent' });
    expect(menu.groups).toEqual([]);
  });
});

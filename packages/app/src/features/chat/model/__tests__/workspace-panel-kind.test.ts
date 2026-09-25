import { describe, expect, it } from 'vitest';

import { workspacePanelKind } from '@/features/chat/model/workspace-panel-kind';

const artifact = (type: 'code' | 'image') => ({ id: type, type, content: '', timestamp: 0 });

describe('which of the template panels the slot shows', () => {
  it('is the code panel by default, as the template opens', () => {
    expect(workspacePanelKind(null, [])).toBe('code');
  });

  it('follows the last thing Alia made: an image turns it into the gallery', () => {
    expect(workspacePanelKind(null, [artifact('code'), artifact('image')])).toBe('gallery');
    expect(workspacePanelKind(null, [artifact('image'), artifact('code')])).toBe('code');
  });

  it('gives the slot to a panel something opened, and "canvas" means the code panel', () => {
    expect(workspacePanelKind('thought', [artifact('image')])).toBe('thought');
    expect(workspacePanelKind('credits', [])).toBe('credits');
    expect(workspacePanelKind('agent', [])).toBe('agent');
    expect(workspacePanelKind('canvas', [artifact('image')])).toBe('code');
    expect(workspacePanelKind('gallery', [])).toBe('gallery');
  });
});

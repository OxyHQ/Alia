import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/agent-panel', () => ({ AgentPanel: () => null }));
vi.mock('@/components/canvas/canvas-component', () => ({ CanvasComponent: () => null }));
vi.mock('@/components/credits-limits', () => ({ CreditsLimits: () => null }));
vi.mock('@/components/thought-panel', () => ({ ThoughtPanel: () => null }));
vi.mock('@/lib/stores/library-store', () => ({ useLibraryStore: () => null }));
vi.mock('@/lib/stores/ui-store', () => ({ useUIStore: () => null }));
vi.mock('@/lib/hooks/use-translation', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@oxy.so/services', () => ({ useOxy: () => ({ isAuthenticated: false }) }));
vi.mock('@oxy.so/bloom/ai-chat', () => ({ AiChatCodePanel: () => null, AiChatGalleryPanel: () => null }));
vi.mock('react-native', () => ({ View: () => null }));
for (const name of ['RiCodeSLine', 'RiGalleryLine', 'RiLightbulbLine', 'RiQuillPenLine', 'RiRobot2Line']) {
  vi.doMock(`@oxy.so/bloom/icons/${name}`, () => ({ [name]: () => null }));
}

const { workspacePanelKind } = await import('../workspace-panel');

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

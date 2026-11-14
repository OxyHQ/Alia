import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The canvas is the open conversation's. It used to be the session's: after a chat that generated
 * an image, the new-chat screen's panel opened that image beside an empty chat.
 */

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
  },
}));

const { useUIStore } = await import('../ui-store');

const image = { id: 'a1', type: 'image' as const, content: 'x', timestamp: 1 };

beforeEach(() => {
  useUIStore.setState({ canvasArtifacts: [], canvasConversationId: null });
});

describe('the canvas of the conversation on show', () => {
  it('starts empty in a new chat, and in another conversation', () => {
    const ui = useUIStore.getState();
    ui.showConversation('a');
    ui.addCanvasArtifact(image);
    ui.showConversation(null);
    expect(useUIStore.getState().canvasArtifacts).toEqual([]);

    ui.showConversation('a');
    ui.addCanvasArtifact(image);
    ui.showConversation('b');
    expect(useUIStore.getState().canvasArtifacts).toEqual([]);
  });

  it('keeps what a new chat’s first turn wrote in the conversation that turn made', () => {
    const ui = useUIStore.getState();
    ui.showConversation(null);
    ui.addCanvasArtifact(image);
    ui.showConversation('made');
    expect(useUIStore.getState().canvasArtifacts).toEqual([image]);
  });

  it('keeps it while the same conversation stays on show', () => {
    const ui = useUIStore.getState();
    ui.showConversation('a');
    ui.addCanvasArtifact(image);
    ui.showConversation('a');
    expect(useUIStore.getState().canvasArtifacts).toEqual([image]);
  });
});

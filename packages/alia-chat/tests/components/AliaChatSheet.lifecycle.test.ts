import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../src/components/AliaChatSheet.tsx', import.meta.url), 'utf8');

describe('AliaChatSheet request lifecycle wiring', () => {
  it('stops text generation when button, backdrop or system dismissal begins', () => {
    expect(source).toMatch(
      /const handleDismiss = useCallback\(\(\) => \{\s*stopChat\(\);/,
    );
    expect(source).toMatch(/onRequestClose=\{handleDismiss\}/);
    expect(source).toMatch(/onPress=\{handleDismiss\}/);
  });

  it('stops text generation when a pan gesture commits to closing', () => {
    expect(source).toMatch(/if \(shouldClose\) \{\s*runOnJS\(stopChat\)\(\);/);
  });

  it('registers the exact stop callback owned by the mounted chat content', () => {
    expect(source).toMatch(/onStopReady=\{registerChatStop\}/);
  });
});

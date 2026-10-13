import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../../src/components/AliaChatSheet.tsx', import.meta.url),
  'utf8',
);

describe('AliaChatSheet request lifecycle wiring', () => {
  it('stops text generation when the button or the imperative dismiss begins', () => {
    expect(source).toMatch(/const handleDismiss = useCallback\(\(\) => \{\s*stopChat\(\);/);
    expect(source).toMatch(/onClose=\{handleDismiss\}/);
  });

  it('stops text generation when a drag, backdrop press, Back or Escape starts closing', () => {
    expect(source).toMatch(
      /const onDismissAttempt = useCallback\(\(\) => \{\s*stopChat\(\);\s*return true;/,
    );
    expect(source).toMatch(/onDismissAttempt=\{onDismissAttempt\}/);
    expect(source).toMatch(/onDismiss=\{stopChat\}/);
  });

  it('registers the exact stop callback owned by the mounted chat content', () => {
    expect(source).toMatch(/onStopReady=\{registerChatStop\}/);
  });
});

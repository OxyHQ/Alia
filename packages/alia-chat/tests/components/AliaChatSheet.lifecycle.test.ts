import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) =>
  readFileSync(new URL(`../../src/components/${file}`, import.meta.url), 'utf8');
const source = read('AliaChatSheet.tsx');
const content = read('AliaChatContent.tsx');

describe('AliaChatSheet request lifecycle wiring', () => {
  it('stops both chats when the imperative dismiss begins', () => {
    expect(source).toMatch(
      /const handleDismiss = useCallback\(\(\) => \{\s*conversationStopRef\.current\?\.\(\);\s*mainStopRef\.current\?\.\(\);/,
    );
  });

  it('stops the turn when a drag, backdrop press, Back or Escape starts closing either sheet', () => {
    expect(source).toMatch(/onDismissAttempt=\{onMainDismissAttempt\}/);
    expect(source).toMatch(/onDismissAttempt=\{onConversationDismissAttempt\}/);
    expect(source).toMatch(
      /const onConversationDismissAttempt = useCallback\(\(\) => \{\s*conversationStopRef\.current\?\.\(\);\s*return true;/,
    );
  });

  it("registers each sheet's own stop callback with its chat content", () => {
    expect(source).toMatch(/onStopReady=\{registerMainStop\}/);
    expect(source).toMatch(/onStopReady=\{registerConversationStop\}/);
  });
});

describe('AliaChatSheet stacking', () => {
  it('opens the conversation in a second sheet over the main one, a fresh chat each time', () => {
    expect(source).toMatch(/onStart=\{startConversation\}/);
    expect(source).toMatch(/\{conversation \? \(\s*<BottomSheet\s+key=\{conversation\.key\}/);
    expect(source).toMatch(/initialTurn=\{conversation\.turn\}/);
  });

  it("takes the conversation's back button to the main screen, closing only the top sheet", () => {
    expect(source).toMatch(/onBack=\{closeConversation\}/);
    expect(source).toMatch(/onClear=\{closeConversation\}/);
    expect(source).not.toMatch(/onBack=\{handleDismiss\}/);
  });

  it('has no header over the main screen: only the conversation sheet draws one', () => {
    expect(source.match(/<AliaChatHeader/g)).toHaveLength(1);
  });

  it("hands an empty chat's first turn to the host and sends the initial turn once", () => {
    expect(content).toMatch(/onStart\?: \(turn: AliaTurn\) => void/);
    expect(content).toMatch(/if \(startsElsewhere\) onStart\(\{ text, images \}\)/);
    expect(content).toMatch(/initialSent\.current = true/);
  });
});

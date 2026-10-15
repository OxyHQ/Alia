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
    expect(content).toMatch(/if \(startsElsewhere\) \{[\s\S]*?onStart\(\{ text, images \}\)/);
    expect(content).toMatch(/initialSent\.current = true/);
  });
});

describe('AliaChatSheet avatar flights', () => {
  it('shares one flights controller and one layer between the two sheets', () => {
    expect(source.match(/useAvatarFlights\(\)/g)).toHaveLength(1);
    expect(source.match(/<AvatarFlightLayer flights=\{flights\} \/>/g)).toHaveLength(1);
    expect(source).toMatch(/const shared = \{\s*flights,/);
  });

  it('launches the greeting avatar into the header with the first turn, once the conversation sheet is open', () => {
    expect(content).toMatch(
      /onStart\(\{ text, images \}\);\s*await flights\.launch\(\[ALIA_TO_PROFILE\]\)/,
    );
    expect(content).toMatch(
      /if \(firstTurn\) await flights\.launch\(\[ALIA_TO_PROFILE\]\);\s*send\(/,
    );
  });

  it('draws its own layer only when the host shares none', () => {
    expect(content).toMatch(
      /\{sharedFlights \? null : <AvatarFlightLayer flights=\{ownFlights\} \/>\}/,
    );
  });

  it('anchors the greeting avatar and the header profile under the same keys the flight names', () => {
    const flights = read('../lib/flights.ts');
    expect(flights).toMatch(/welcome: 'alia:welcome'/);
    expect(flights).toMatch(/profile: 'alia:profile'/);
    expect(read('AliaWelcomeMessage.tsx')).toMatch(/anchor=\{ALIA_ANCHORS\.welcome\}/);
    expect(read('AliaChatHeader.tsx')).toMatch(/flights\?\.anchor\(ALIA_ANCHORS\.profile\)/);
    expect(read('AliaChatHeader.tsx')).toMatch(
      /avatarHidden=\{flights\?\.isLanding\(ALIA_ANCHORS\.profile\)\}/,
    );
  });
});

describe('AliaChatSheet focus', () => {
  it("hands each sheet's presented progress to its own chat, and Bloom's sheet reports it", () => {
    expect(source).toMatch(/animatedProgress=\{mainProgress\}/);
    expect(source).toMatch(/presentedProgress=\{mainProgress\}/);
    expect(source).toMatch(/animatedProgress=\{conversationProgress\}/);
    expect(source).toMatch(/presentedProgress=\{conversationProgress\}/);
  });

  it('focuses the composer field when the sheet is up, and uses no timer to wait for it', () => {
    expect(content).toMatch(
      /useFocusWhenPresented\(presentedProgress, \(\) => composerRef\.current\?\.focus\(\)\)/,
    );
    expect(content).toMatch(/inputRef=\{composerRef\}/);
    expect(read('../hooks/useFocusWhenPresented.ts')).not.toMatch(
      /setTimeout|requestAnimationFrame/,
    );
  });
});

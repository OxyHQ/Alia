import { describe, expect, it } from 'vitest';
import {
  dropEchoPrefix,
  isInterruption,
  stripTitleTags,
  stripTitleTagsPartial,
  takeSpeechChunks,
  toSpeakableText,
} from '../../src/lib/voice-text';

describe('what of a streaming answer can be spoken now', () => {
  it('speaks the first sentence as soon as it is complete, however short', () => {
    expect(takeSpeechChunks('Sure. Here is the', { final: false, isFirst: true })).toEqual({
      chunks: ['Sure.'],
      rest: 'Here is the',
    });
  });

  it('waits for whitespace after a period, so a decimal or an abbreviation is not a sentence end', () => {
    expect(takeSpeechChunks('It costs 3.', { final: false, isFirst: true })).toEqual({ chunks: [], rest: 'It costs 3.' });
    expect(takeSpeechChunks('It costs 3.5 euros', { final: false, isFirst: true }).chunks).toEqual([]);
  });

  it('gathers later sentences into fuller chunks, and keeps a short tail for later', () => {
    const later = takeSpeechChunks('One. Two. ', { final: false, isFirst: false });
    expect(later.chunks).toEqual([]);
    expect(later.rest).toBe('One. Two. ');
    const long = 'This sentence is long enough that it should be spoken as its own chunk right away. Short. ';
    expect(takeSpeechChunks(long, { final: false, isFirst: false }).chunks).toEqual([
      'This sentence is long enough that it should be spoken as its own chunk right away.',
    ]);
  });

  it('flushes everything, sentence end or not, when the answer is final', () => {
    expect(takeSpeechChunks('One. Two', { final: true, isFirst: false })).toEqual({ chunks: ['One. Two'], rest: '' });
  });

  it('cuts a run with no sentence end at a pause once it is too long to wait for', () => {
    const run = `${'word, '.repeat(60)}more`;
    const { chunks, rest } = takeSpeechChunks(run, { final: false, isFirst: true });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.endsWith(',')).toBe(true);
    expect(rest.length).toBeLessThan(run.length);
  });
});

describe('speakable text', () => {
  it('takes markdown, code and links off without losing the words', () => {
    expect(toSpeakableText('**Bold** and _it_ with `code` and [a link](https://x.test) at https://y.test')).toBe(
      'Bold and it with code and a link at',
    );
    expect(toSpeakableText('# Title\n- one\n- two')).toBe('Title one two');
    expect(toSpeakableText('Before\n```js\nconst x = 1;\n```\nAfter')).toBe('Before After');
  });

  it('strips the conversation-title tag, whole or still streaming', () => {
    expect(stripTitleTags('Hola. [TITLE]Saludo[/TITLE]')).toBe('Hola.');
    expect(stripTitleTagsPartial('Hola. [TITLE]Salu')).toBe('Hola.');
  });
});

describe('telling the person from the echo', () => {
  const spoken = 'The weather in Madrid is sunny today with a high of twenty degrees';

  it('does not treat the answer coming back through the microphone as an interruption', () => {
    expect(isInterruption('the weather in Madrid is sunny', spoken, 2)).toBe(false);
    // Echo the recognizer got slightly wrong is still echo.
    expect(isInterruption('the weather in Madrit is sunny today', spoken, 2)).toBe(false);
    expect(isInterruption('the wether in Madrit is sunny today', spoken, 2)).toBe(false);
  });

  it('treats new words as the person cutting in — even after echo in the same session', () => {
    expect(isInterruption('wait stop', spoken, 2)).toBe(true);
    expect(isInterruption('the weather in Madrid wait stop what about tomorrow', spoken, 2)).toBe(true);
    expect(isInterruption('the weather in Madrid is sunny wait stop', spoken, 2)).toBe(true);
  });

  it('needs more than one word, so a cough or a stray word does not cut the answer off', () => {
    expect(isInterruption('hmm', '', 2)).toBe(false);
    expect(isInterruption('hold on', '', 2)).toBe(true);
  });

  it('keeps only what the person said after the echo', () => {
    expect(dropEchoPrefix('the weather in Madrid wait what about Paris', spoken)).toBe('wait what about Paris');
    expect(dropEchoPrefix('what about Paris', '')).toBe('what about Paris');
  });
});

import { describe, expect, it } from 'vitest';
import { greetingLines } from '../../src/lib/greeting';

describe('greetingLines', () => {
  it('puts the address on top and the rest under it, breaking after the first comma', () => {
    expect(greetingLines("Hi Nate, what's on your mind?")).toEqual([
      'Hi Nate,',
      "what's on your mind?",
    ]);
  });

  it('breaks at the first comma only', () => {
    expect(greetingLines('Hola, Nate, ¿qué tal?')).toEqual(['Hola,', 'Nate, ¿qué tal?']);
  });

  it('breaks after the commas of other scripts too', () => {
    expect(greetingLines('你好，Nate 今天想聊点什么？')).toEqual([
      '你好，',
      'Nate 今天想聊点什么？',
    ]);
    expect(greetingLines('こんにちは、Nate さん')).toEqual(['こんにちは、', 'Nate さん']);
    expect(greetingLines('مرحبا، كيف حالك؟')).toEqual(['مرحبا،', 'كيف حالك؟']);
  });

  it('keeps a greeting with no comma, or nothing after it, as one line', () => {
    expect(greetingLines('Welcome back')).toEqual(['Welcome back']);
    expect(greetingLines('Hi Nate,')).toEqual(['Hi Nate,']);
    expect(greetingLines('Hi Nate,   ')).toEqual(['Hi Nate,   ']);
  });
});

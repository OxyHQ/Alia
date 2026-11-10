import { describe, expect, it } from 'vitest';
import {
  createToolMarkupGuard,
  parseDsmlToolCalls,
  stripDsmlToolMarkup,
  withoutToolMarkup,
} from '../tool-markup.js';

const DSML =
  '<｜DSML｜function_calls>\n<｜DSML｜invoke name="oxy_nilo_memories__recallMemories">\n' +
  '<｜DSML｜parameter name="query" string="true">my name</｜DSML｜parameter>\n' +
  '<｜DSML｜parameter name="limit" string="false">3</｜DSML｜parameter>\n' +
  '</｜DSML｜invoke>\n</｜DSML｜function_calls>';

/** Feed `text` to a guard in chunks of `size`, as a stream would. */
function run(text: string, size: number) {
  const guard = createToolMarkupGuard();
  let shown = '';
  for (let i = 0; i < text.length; i += size) shown += guard.push(text.slice(i, i + size));
  shown += guard.flush();
  return { shown, withheld: guard.withheld };
}

describe('createToolMarkupGuard', () => {
  it.each([1, 2, 3, 5, 7, 64])(
    'shows only the words before DSML markup, in chunks of %i',
    (size) => {
      const { shown, withheld } = run(`Sure, let me check. ${DSML}`, size);
      expect(shown).toBe('Sure, let me check. ');
      expect(withheld).toBe(DSML);
    },
  );

  it.each([1, 4, 9])('passes plain text, even with a lone "<", whole (chunks of %i)', (size) => {
    const text = 'a < b and <b>bold</b> and <function ok';
    expect(run(text, size)).toEqual({ shown: text, withheld: '' });
  });

  it('holds a tail that might start a marker, then releases it when it does not', () => {
    const guard = createToolMarkupGuard();
    expect(guard.push('hello <func')).toBe('hello ');
    expect(guard.push('tion is a word')).toBe('<function is a word');
    expect(guard.withheld).toBe('');
  });

  it('releases a held tail at the end of the stream', () => {
    const guard = createToolMarkupGuard();
    expect(guard.push('it costs <｜')).toBe('it costs ');
    expect(guard.flush()).toBe('<｜');
  });

  it.each([
    '<function(getWeather)>{"city":"Rome"}</function>',
    '<tool_call>{"name":"x"}</tool_call>',
  ])('withholds %s', (markup) => {
    expect(run(`ok ${markup}`, 3)).toEqual({ shown: 'ok ', withheld: markup });
  });

  it('speaks again after the withheld markup is taken, for the next step of a turn', () => {
    const guard = createToolMarkupGuard();
    expect(guard.push('a <function(x)>{}</function>')).toBe('a ');
    expect(guard.take()).toBe('<function(x)>{}</function>');
    expect(guard.push('the answer')).toBe('the answer');
    expect(guard.withheld).toBe('');
  });

  it('shows nothing of a turn that is only markup', () => {
    expect(run(DSML, 6).shown).toBe('');
  });
});

describe('DSML tool calls', () => {
  it('reads the call, its string and JSON parameters', () => {
    expect(parseDsmlToolCalls(DSML)).toEqual([
      { name: 'oxy_nilo_memories__recallMemories', args: { query: 'my name', limit: 3 } },
    ]);
  });

  it('reads no call from a block cut off mid-call', () => {
    const cut =
      '<｜DSML｜invoke name="oxy_nilo_memories__recallMemories"> <｜DSML｜parameter name="query" string="true">';
    expect(parseDsmlToolCalls(cut)).toEqual([]);
    expect(stripDsmlToolMarkup(`Hi! ${cut}`)).toBe('Hi!');
  });

  it('strips whole blocks and leaves the model’s own words', () => {
    expect(stripDsmlToolMarkup(`Checking.\n${DSML}`)).toBe('Checking.');
  });
});

describe('withoutToolMarkup', () => {
  it('keeps the words and drops the call', () => {
    expect(withoutToolMarkup(`Hello. ${DSML}`)).toBe('Hello. ');
    expect(withoutToolMarkup('plain')).toBe('plain');
  });
});

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * `AliaMarkdown` is a wrapper: the parser, the streaming and the colours are Bloom's. These pin
 * what it hands over — the chat reading size, the streaming flag and the host's code card — so a
 * reply is never set in Bloom's default `md` ramp or re-read in full on every token.
 */
const seen = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));

vi.mock('@oxy.so/bloom/markdown', () => ({
  Markdown: (props: Record<string, unknown>) => {
    seen.props.push(props);
    return null;
  },
}));

import { AliaMarkdown, MARKDOWN_BODY } from '../../src/components/Markdown';

describe('AliaMarkdown', () => {
  it('sets the text in Bloom Markdown at its chat reading size, matching the bubble padding', () => {
    seen.props.length = 0;
    const renderCodeBlock = () => null;
    act(() => {
      TestRenderer.create(
        <AliaMarkdown content="**hi**" streaming renderCodeBlock={renderCodeBlock} />,
      );
    });
    expect(seen.props[0]).toMatchObject({
      size: 'lg',
      streaming: true,
      renderCodeBlock,
      children: '**hi**',
    });
    expect(MARKDOWN_BODY).toEqual({ fontSize: 16, lineHeight: 28 });
  });

  it('is not streaming unless told so', () => {
    seen.props.length = 0;
    act(() => {
      TestRenderer.create(<AliaMarkdown content="done" />);
    });
    expect(seen.props).toHaveLength(1);
    expect(seen.props[0]?.streaming).toBeFalsy();
  });
});

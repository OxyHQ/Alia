import type { ReactNode } from 'react';
import { Markdown } from '@oxy.so/bloom/markdown';

/** The body text of a reply: its bubble sets its padding from these. Bloom's `lg` ramp. */
export const MARKDOWN_BODY = { fontSize: 16, lineHeight: 28 } as const;

export type RenderCodeBlock = (code: string, language: string | undefined) => ReactNode;

export interface AliaMarkdownProps {
  content: string;
  /** The text is still arriving: an unfinished trailing construct closes implicitly. */
  streaming?: boolean;
  /**
   * Draw fenced code with the host's own code card. Keep the function's identity stable (a
   * module-level function or a `useCallback`): it is called once per render of each block.
   */
  renderCodeBlock?: RenderCodeBlock;
}

/**
 * A reply or a thought, set in Bloom's `Markdown` at its chat reading size. Bloom owns the parser
 * (no `markdown-it`, no `linkify-it`), the streaming behaviour (only the last block is re-read as
 * the text grows) and the colours, which follow the app's chosen theme.
 */
export function AliaMarkdown({ content, streaming, renderCodeBlock }: AliaMarkdownProps) {
  return (
    <Markdown size="lg" streaming={streaming} renderCodeBlock={renderCodeBlock}>
      {content}
    </Markdown>
  );
}

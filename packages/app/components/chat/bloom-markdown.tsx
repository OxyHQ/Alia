import { extractCitationSources, linkifyCitations, splitReferences, type CitationSource } from '@/lib/citations';
import type { ToolInvocation } from '@/lib/types/messages';
import {
  AiChatBullet,
  AiChatBulletList,
  AiChatLinkChip,
  AiChatMessageLine,
  AiChatStrong,
} from '@oxy.so/bloom/ai-chat';
import { Code, CodeBlock } from '@oxy.so/bloom/code';
import * as WebBrowser from 'expo-web-browser';
import { Lexer, type Token, type Tokens } from 'marked';
import React from 'react';

/**
 * A reply's Markdown as the AI Chat template writes one: every block is a
 * direct child of `AiChatAssistantMessage` (so Bloom's reveal staggers them),
 * paragraphs are `AiChatMessageLine`, lists `AiChatBulletList`, emphasis
 * `AiChatStrong`, links `AiChatLinkChip` and fences `CodeBlock`. Nothing here
 * draws a pixel of its own.
 */
export function bloomMarkdown({
  content,
  toolInvocations,
  researchSources,
}: {
  content: string;
  toolInvocations?: ToolInvocation[];
  researchSources?: Array<{ id: number; url: string; title: string }> | null;
}): React.ReactNode[] {
  const sources: CitationSource[] = extractCitationSources(toolInvocations, researchSources);
  const { body } = splitReferences(content, sources);
  const tokens = Lexer.lex(linkifyCitations(body, sources), { gfm: true });
  return tokens.flatMap((token, index) => block(token, `b${index}`));
}

function open(url: string) {
  void WebBrowser.openBrowserAsync(url);
}

function block(token: Token, key: string): React.ReactNode[] {
  switch (token.type) {
    case 'space':
    case 'hr':
      return [];
    case 'paragraph':
    case 'text':
      return [<AiChatMessageLine key={key}>{inline((token as Tokens.Paragraph).tokens ?? [], key)}</AiChatMessageLine>];
    case 'heading':
      return [
        <AiChatMessageLine key={key}>
          <AiChatStrong>{plain((token as Tokens.Heading).tokens)}</AiChatStrong>
        </AiChatMessageLine>,
      ];
    case 'code': {
      const code = token as Tokens.Code;
      return [
        <AiChatMessageLine key={key} block>
          <CodeBlock code={code.text} language={code.lang || undefined} />
        </AiChatMessageLine>,
      ];
    }
    case 'list': {
      const list = token as Tokens.List;
      if (list.ordered) {
        const start = typeof list.start === 'number' ? list.start : 1;
        return list.items.map((item, i) => (
          <AiChatMessageLine key={`${key}-${i}`}>
            {`${start + i}. `}
            {itemInline(item, `${key}-${i}`)}
          </AiChatMessageLine>
        ));
      }
      return [
        <AiChatBulletList key={key}>
          {list.items.map((item, i) => (
            <AiChatBullet key={`${key}-${i}`}>{itemInline(item, `${key}-${i}`)}</AiChatBullet>
          ))}
        </AiChatBulletList>,
      ];
    }
    case 'blockquote':
      return [
        <AiChatMessageLine key={key} tone="secondary">
          {plain((token as Tokens.Blockquote).tokens)}
        </AiChatMessageLine>,
      ];
    case 'table': {
      const table = token as Tokens.Table;
      const rows = [table.header, ...table.rows].map((cells) => cells.map((c) => c.text).join(' · '));
      return rows.map((row, i) => (
        <AiChatMessageLine key={`${key}-${i}`} tone={i === 0 ? 'secondary' : 'primary'}>
          {row}
        </AiChatMessageLine>
      ));
    }
    default:
      return 'raw' in token && token.raw.trim() ? [<AiChatMessageLine key={key}>{token.raw.trim()}</AiChatMessageLine>] : [];
  }
}

/** A list item's first line of prose; nested blocks fold into it. */
function itemInline(item: Tokens.ListItem, key: string): React.ReactNode {
  return item.tokens.map((token, i) =>
    token.type === 'text' || token.type === 'paragraph'
      ? <React.Fragment key={i}>{inline((token as Tokens.Text).tokens ?? [{ type: 'text', raw: token.raw, text: (token as Tokens.Text).text }], `${key}-${i}`)}</React.Fragment>
      : token.type === 'list'
        ? <React.Fragment key={i}>{'\n'}{(token as Tokens.List).items.map((sub) => `• ${sub.text}`).join('\n')}</React.Fragment>
        : null,
  );
}

function inline(tokens: Token[], key: string): React.ReactNode[] {
  return tokens.map((token, i) => {
    const k = `${key}-${i}`;
    switch (token.type) {
      case 'strong':
        return <AiChatStrong key={k}>{plain((token as Tokens.Strong).tokens)}</AiChatStrong>;
      case 'em':
      case 'del':
        return <React.Fragment key={k}>{inline((token as Tokens.Em).tokens, k)}</React.Fragment>;
      case 'codespan':
        return <Code key={k}>{(token as Tokens.Codespan).text}</Code>;
      case 'link': {
        const link = token as Tokens.Link;
        return (
          <AiChatLinkChip key={k} onPress={() => open(link.href)}>
            {plain(link.tokens) || link.href}
          </AiChatLinkChip>
        );
      }
      case 'br':
        return '\n';
      case 'text': {
        const text = token as Tokens.Text;
        return text.tokens ? <React.Fragment key={k}>{inline(text.tokens, k)}</React.Fragment> : decode(text.text);
      }
      case 'escape':
        return (token as Tokens.Escape).text;
      default:
        return 'text' in token ? decode(String(token.text)) : token.raw;
    }
  });
}

function plain(tokens: Token[] | undefined): string {
  return (tokens ?? []).map((t) => ('tokens' in t && t.tokens ? plain(t.tokens as Token[]) : 'text' in t ? decode(String(t.text)) : t.raw)).join('');
}

/** `marked` escapes entities in text runs; the reply is not HTML. */
function decode(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

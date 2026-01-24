import React from "react";
import { View } from "react-native";
import Markdown from "react-native-markdown-display";
import { useColorScheme } from "@/lib/useColorScheme";
import {
  H1 as ExpoH1,
  H2 as ExpoH2,
  H3 as ExpoH3,
  H4 as ExpoH4,
  H5 as ExpoH5,
  H6 as ExpoH6,
  Code as ExpoCode,
  Pre as ExpoPre,
  UL as ExpoUl,
  LI as ExpoLI,
  Strong as ExpoStrong,
  A as ExpoA,
  P as ExpoP,
  Div as ExpoDiv,
} from "@expo/html-elements";
import { cssInterop } from "nativewind";
import {
  CompactList,
  Banner,
  Comparison,
  Timeline,
  RichImage,
  Credibility,
} from "./rich-blocks";

const H1 = cssInterop(ExpoH1, { className: "style" });
const H2 = cssInterop(ExpoH2, { className: "style" });
const H3 = cssInterop(ExpoH3, { className: "style" });
const H4 = cssInterop(ExpoH4, { className: "style" });
const H5 = cssInterop(ExpoH5, { className: "style" });
const H6 = cssInterop(ExpoH6, { className: "style" });
const Code = cssInterop(ExpoCode, { className: "style" });
const Pre = cssInterop(ExpoPre, { className: "style" });
const Ol = cssInterop(ExpoUl, { className: "style" });
const Ul = cssInterop(ExpoUl, { className: "style" });
const Li = cssInterop(ExpoLI, { className: "style" });
const Strong = cssInterop(ExpoStrong, { className: "style" });
const A = cssInterop(ExpoA, { className: "style" });
const P = cssInterop(ExpoP, { className: "style" });
const Div = cssInterop(ExpoDiv, { className: "style" });

const rules = {
  heading1: (node: any, children: any) => (
    <H1 className="mb-2 mt-3 text-lg font-semibold text-foreground leading-snug">{children}</H1>
  ),
  heading2: (node: any, children: any) => (
    <H2 className="mb-2 mt-3 text-base font-semibold text-foreground leading-snug">{children}</H2>
  ),
  heading3: (node: any, children: any) => (
    <H3 className="mb-1.5 mt-2 text-base font-semibold text-foreground leading-snug">{children}</H3>
  ),
  heading4: (node: any, children: any) => (
    <H4 className="mb-1.5 mt-2 text-base font-medium text-foreground leading-snug">{children}</H4>
  ),
  heading5: (node: any, children: any) => (
    <H5 className="mb-1 mt-2 text-base font-medium text-foreground leading-snug">{children}</H5>
  ),
  heading6: (node: any, children: any) => (
    <H6 className="mb-1 mt-2 text-base font-medium text-foreground leading-snug">{children}</H6>
  ),
  code: (node: any, children: any, parent: any) => {
    return parent.length > 1 ? (
      <Pre className="my-2 max-w-full overflow-x-auto rounded-md bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 p-3 text-[13px] text-foreground">
        <Code className="text-foreground font-mono">{children}</Code>
      </Pre>
    ) : (
      <Code
        className="bg-zinc-100 dark:bg-zinc-800 px-1 py-px text-[13px] text-foreground font-mono"
        style={{ borderRadius: 3 }}
      >
        {children}
      </Code>
    );
  },
  list_item: (node: any, children: any) => <Li className="py-0.5 text-base leading-7 text-foreground">{children}</Li>,
  ordered_list: (node: any, children: any) => (
    <Ol className="ml-5 my-2 list-outside list-decimal text-foreground">{children}</Ol>
  ),
  unordered_list: (node: any, children: any) => (
    <Ul className="ml-5 my-2 list-outside list-disc text-foreground">{children}</Ul>
  ),
  strong: (node: any, children: any) => (
    <Strong className="font-semibold text-foreground">{children}</Strong>
  ),
  link: (node: any, children: any) => (
    <A
      className="text-blue-600 dark:text-blue-400 underline hover:text-blue-700 dark:hover:text-blue-300"
      target="_blank"
      rel="noreferrer"
      href={node.attributes.href}
    >
      {children}
    </A>
  ),
  paragraph: (node: any, children: any) => {
    return <P className="mb-2 text-base leading-7 text-foreground">{children}</P>;
  },
  text: (node: any) => {
    return node.content;
  },
  body: (node: any, children: any) => {
    return <Div className="text-foreground">{children}</Div>;
  },
};

// Parse special blocks from content
function parseSpecialBlocks(content: string): Array<{ type: 'text' | 'block'; content: string; blockType?: string; data?: any }> {
  const blocks: Array<{ type: 'text' | 'block'; content: string; blockType?: string; data?: any }> = [];

  // Patterns for special blocks
  const patterns = [
    { name: 'COMPACTLIST', regex: /\[COMPACTLIST title="([^"]+)"\]([\s\S]*?)\[\/COMPACTLIST\]/g },
    { name: 'BANNER', regex: /\[BANNER type="([^"]+)" title="([^"]+)"\]([\s\S]*?)\[\/BANNER\]/g },
    { name: 'COMPARISON', regex: /\[COMPARISON title="([^"]+)"\]([\s\S]*?)\[\/COMPARISON\]/g },
    { name: 'TIMELINE', regex: /\[TIMELINE title="([^"]+)"\]([\s\S]*?)\[\/TIMELINE\]/g },
    { name: 'IMAGE', regex: /\[IMAGE url="([^"]+)"(?:\s+title="([^"]*)")?\s*(?:caption="([^"]*)")?\s*\/\]/g },
    { name: 'CREDIBILITY', regex: /\[CREDIBILITY level="(\d+)" source="([^"]+)"\s*\/\]/g },
  ];

  let lastIndex = 0;
  const matches: Array<{ index: number; length: number; block: any }> = [];

  // Find all matches
  patterns.forEach(({ name, regex }) => {
    let match;
    const regexCopy = new RegExp(regex.source, regex.flags);
    while ((match = regexCopy.exec(content)) !== null) {
      matches.push({
        index: match.index,
        length: match[0].length,
        block: { type: name, match, fullMatch: match[0] },
      });
    }
  });

  // Sort matches by index
  matches.sort((a, b) => a.index - b.index);

  // Build blocks array
  matches.forEach((m) => {
    // Add text before block
    if (lastIndex < m.index) {
      const textContent = content.substring(lastIndex, m.index).trim();
      if (textContent) {
        blocks.push({ type: 'text', content: textContent });
      }
    }

    // Add block
    blocks.push({
      type: 'block',
      content: m.block.fullMatch,
      blockType: m.block.type,
      data: parseBlockData(m.block.type, m.block.match),
    });

    lastIndex = m.index + m.length;
  });

  // Add remaining text
  if (lastIndex < content.length) {
    const textContent = content.substring(lastIndex).trim();
    if (textContent) {
      blocks.push({ type: 'text', content: textContent });
    }
  }

  // If no blocks found, return all as text
  if (blocks.length === 0) {
    blocks.push({ type: 'text', content });
  }

  return blocks;
}

function parseBlockData(type: string, match: RegExpExecArray): any {
  try {
    switch (type) {
      case 'COMPACTLIST': {
        const title = match[1];
        const itemsText = match[2];
        const items = itemsText
          .split('\n')
          .filter((line) => line.trim().startsWith('-'))
          .map((line) => {
            try {
              const jsonStr = line.trim().substring(1).trim();
              return JSON.parse(jsonStr);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        return { title, items };
      }
      case 'BANNER': {
        return {
          type: match[1],
          title: match[2],
          content: match[3].trim(),
        };
      }
      case 'COMPARISON': {
        const title = match[1];
        const content = match[2];
        const leftMatch = content.match(/LEFT:\s*({.*?})/s);
        const rightMatch = content.match(/RIGHT:\s*({.*?})/s);
        const conclusionMatch = content.match(/CONCLUSION:\s*(.*?)$/s);

        return {
          title,
          left: leftMatch ? JSON.parse(leftMatch[1]) : {},
          right: rightMatch ? JSON.parse(rightMatch[1]) : {},
          conclusion: conclusionMatch ? conclusionMatch[1].trim() : undefined,
        };
      }
      case 'TIMELINE': {
        const title = match[1];
        const itemsText = match[2];
        const items = itemsText
          .split('\n')
          .filter((line) => line.trim().startsWith('-'))
          .map((line) => {
            try {
              const jsonStr = line.trim().substring(1).trim();
              return JSON.parse(jsonStr);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        return { title, items };
      }
      case 'IMAGE': {
        return {
          url: match[1],
          title: match[2] || undefined,
          caption: match[3] || undefined,
        };
      }
      case 'CREDIBILITY': {
        return {
          level: parseInt(match[1], 10),
          source: match[2],
        };
      }
      default:
        return {};
    }
  } catch (e) {
    console.error('Error parsing block data:', e);
    return {};
  }
}

function renderBlock(blockType: string, data: any, key: number) {
  switch (blockType) {
    case 'COMPACTLIST':
      return <CompactList key={key} {...data} />;
    case 'BANNER':
      return <Banner key={key} {...data} />;
    case 'COMPARISON':
      return <Comparison key={key} {...data} />;
    case 'TIMELINE':
      return <Timeline key={key} {...data} />;
    case 'IMAGE':
      return <RichImage key={key} {...data} />;
    case 'CREDIBILITY':
      return <Credibility key={key} {...data} />;
    default:
      return null;
  }
}

export function CustomMarkdown({ content }: { content: string }) {
  const blocks = parseSpecialBlocks(content);
  const { colorScheme } = useColorScheme();

  // Define base text color for markdown based on color scheme
  const markdownStyles = {
    body: {
      color: colorScheme === 'dark' ? '#ffffff' : '#0a0a0a',
    },
    text: {
      color: colorScheme === 'dark' ? '#ffffff' : '#0a0a0a',
    },
  };

  return (
    <View>
      {blocks.map((block, idx) => {
        if (block.type === 'text') {
          return <Markdown key={idx} rules={rules} style={markdownStyles}>{block.content}</Markdown>;
        } else if (block.type === 'block' && block.blockType) {
          return renderBlock(block.blockType, block.data, idx);
        }
        return null;
      })}
    </View>
  );
}

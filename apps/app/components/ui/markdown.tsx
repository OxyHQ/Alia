import React from "react";
import { View, Platform, Linking } from "react-native";
import Markdown from "react-native-markdown-display";
import { AliaMarkdown } from '@alia.onl/sdk';
import { useColorScheme } from "@/lib/useColorScheme";
import { Text } from "@/components/ui/text";
import {
  CompactList,
  Banner,
  Comparison,
  Timeline,
  RichImage,
  Credibility,
} from "./rich-blocks";

const rules = {
  heading1: (node: any, children: any) => (
    <Text key={node.key} className="mb-2 mt-3 text-lg font-semibold leading-snug">{children}</Text>
  ),
  heading2: (node: any, children: any) => (
    <Text key={node.key} className="mb-2 mt-3 font-semibold leading-snug">{children}</Text>
  ),
  heading3: (node: any, children: any) => (
    <Text key={node.key} className="mb-1.5 mt-2 font-semibold leading-snug">{children}</Text>
  ),
  heading4: (node: any, children: any) => (
    <Text key={node.key} className="mb-1.5 mt-2 font-medium leading-snug">{children}</Text>
  ),
  heading5: (node: any, children: any) => (
    <Text key={node.key} className="mb-1 mt-2 font-medium leading-snug">{children}</Text>
  ),
  heading6: (node: any, children: any) => (
    <Text key={node.key} className="mb-1 mt-2 font-medium leading-snug">{children}</Text>
  ),
  code: (node: any, children: any, parent: any) => {
    return parent.length > 1 ? (
      <View key={node.key} className="my-2 max-w-full overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 p-3">
        <Text className="text-[13px] font-mono">{children}</Text>
      </View>
    ) : (
      <Text
        key={node.key}
        className="bg-zinc-100 dark:bg-zinc-800 px-1 py-px text-[13px] font-mono"
        style={{ borderRadius: 3 }}
      >
        {children}
      </Text>
    );
  },
  list_item: (node: any, children: any, parent: any, styles: any) => {
    const isOrdered = parent[parent.length - 1]?.type === 'ordered_list';
    const bullet = isOrdered
      ? `${parent[parent.length - 1].children.indexOf(node) + 1}.`
      : '\u2022';

    return (
      <View key={node.key} className="flex-row py-0.5 pl-4">
        <Text className="mr-2 text-muted-foreground" style={{ minWidth: 14 }}>{bullet}</Text>
        <Text className="flex-1">{children}</Text>
      </View>
    );
  },
  ordered_list: (node: any, children: any) => (
    <View key={node.key} className="my-2">{children}</View>
  ),
  unordered_list: (node: any, children: any) => (
    <View key={node.key} className="my-2">{children}</View>
  ),
  strong: (node: any, children: any) => (
    <Text key={node.key} className="font-semibold">{children}</Text>
  ),
  link: (node: any, children: any) => (
    <Text
      key={node.key}
      className="text-blue-600 dark:text-blue-400 underline"
      onPress={() => {
        if (node.attributes?.href) Linking.openURL(node.attributes.href);
      }}
    >
      {children}
    </Text>
  ),
  paragraph: (node: any, children: any) => {
    return <Text key={node.key} className="mb-2">{children}</Text>;
  },
  blockquote: (node: any, children: any) => (
    <View key={node.key} className="my-2 border-l-4 border-zinc-300 dark:border-zinc-600 bg-zinc-50 dark:bg-zinc-800/50 px-3 py-1 rounded-r-md">
      {children}
    </View>
  ),
  hr: (node: any) => (
    <View key={node.key} className="my-4 h-px bg-zinc-300 dark:bg-zinc-600" />
  ),
  text: (node: any) => {
    return node.content;
  },
  body: (node: any, children: any) => {
    return <View key={node.key}>{children}</View>;
  },
};

// Parse special blocks from content
function parseSpecialBlocks(content: string): Array<{ type: 'text' | 'block'; content: string; blockType?: string; data?: any }> {
  const blocks: Array<{ type: 'text' | 'block'; content: string; blockType?: string; data?: any }> = [];

  // Patterns for special blocks
  const patterns = [
    { name: 'COMPACTLIST', regex: /\[(?:ALIA_)?COMPACTLIST title="([^"]+)"\]([\s\S]*?)\[\/(?:ALIA_)?COMPACTLIST\]/g },
    { name: 'BANNER', regex: /\[(?:ALIA_)?BANNER type="([^"]+)" title="([^"]+)"\]([\s\S]*?)\[\/(?:ALIA_)?BANNER\]/g },
    { name: 'COMPARISON', regex: /\[(?:ALIA_)?COMPARISON title="([^"]+)"\]([\s\S]*?)\[\/(?:ALIA_)?COMPARISON\]/g },
    { name: 'TIMELINE', regex: /\[(?:ALIA_)?TIMELINE title="([^"]+)"\]([\s\S]*?)\[\/(?:ALIA_)?TIMELINE\]/g },
    { name: 'IMAGE', regex: /\[(?:ALIA_)?IMAGE url="([^"]+)"(?:\s+title="([^"]*)")?\s*(?:caption="([^"]*)")?\s*\/\]/g },
    { name: 'CREDIBILITY', regex: /\[(?:ALIA_)?CREDIBILITY level="(\d+)" source="([^"]+)"\s*\/\]/g },
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
  const { colorScheme, colors } = useColorScheme();

  const textColor = colorScheme === 'dark' ? '#ffffff' : '#0a0a0a';
  const sansFont = Platform.select({ ios: 'Inter', android: 'Inter', default: 'Inter, sans-serif' });
  const monoFont = Platform.select({ ios: 'Courier', android: 'monospace', default: 'monospace' });

  // Styles for elements rendered by the library's internal rules (not overridden by custom rules).
  // fontSize/lineHeight on body+text cascade to all descendant text nodes via the library's
  // style inheritance system, ensuring consistent sizing even for em, s, textgroup, etc.
  const markdownStyles = {
    body: {
      color: textColor,
      fontSize: 16,
      lineHeight: 28,
      fontFamily: sansFont,
    },
    text: {
      color: textColor,
      fontSize: 16,
      lineHeight: 28,
      fontFamily: sansFont,
    },
    paragraph: {
      marginTop: 0,
      marginBottom: 8,
    },
    strong: {
      fontWeight: '600' as const,
    },
    em: {
      fontStyle: 'italic' as const,
    },
    s: {
      textDecorationLine: 'line-through' as const,
    },
    bullet_list_icon: {
      marginLeft: 0,
      marginRight: 8,
      fontSize: 16,
      lineHeight: 28,
    },
    ordered_list_icon: {
      marginLeft: 0,
      marginRight: 8,
      fontSize: 16,
      lineHeight: 28,
    },
    bullet_list_content: {
      flex: 1,
    },
    ordered_list_content: {
      flex: 1,
    },
    code_inline: {
      fontSize: 13,
      fontFamily: monoFont,
      backgroundColor: colorScheme === 'dark' ? '#27272a' : '#f4f4f5',
      borderWidth: 0,
      borderRadius: 3,
      paddingHorizontal: 4,
      paddingVertical: 1,
    },
    code_block: {
      fontSize: 13,
      fontFamily: monoFont,
      backgroundColor: colorScheme === 'dark' ? '#18181b' : '#f4f4f5',
      borderWidth: 1,
      borderColor: colorScheme === 'dark' ? '#3f3f46' : '#e4e4e7',
      borderRadius: 6,
      padding: 12,
    },
    fence: {
      fontSize: 13,
      fontFamily: monoFont,
      backgroundColor: colorScheme === 'dark' ? '#18181b' : '#f4f4f5',
      borderWidth: 1,
      borderColor: colorScheme === 'dark' ? '#3f3f46' : '#e4e4e7',
      borderRadius: 6,
      padding: 12,
    },
    table: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      marginVertical: 8,
    },
    thead: {
      backgroundColor: colors.muted,
    },
    th: {
      flex: 1,
      padding: 8,
      fontWeight: '600' as const,
      fontSize: 16,
      lineHeight: 28,
    },
    td: {
      flex: 1,
      padding: 8,
      fontSize: 16,
      lineHeight: 28,
    },
    tr: {
      borderBottomWidth: 1,
      borderColor: colors.border,
      flexDirection: 'row' as const,
    },
    link: {
      textDecorationLine: 'underline' as const,
      color: colorScheme === 'dark' ? '#60a5fa' : '#2563eb',
      fontSize: 16,
      lineHeight: 28,
    },
    hr: {
      backgroundColor: colorScheme === 'dark' ? '#3f3f46' : '#d4d4d8',
      height: 1,
      marginVertical: 16,
    },
    heading1: { fontSize: 18, fontWeight: '600' as const },
    heading2: { fontSize: 16, fontWeight: '600' as const },
    heading3: { fontSize: 16, fontWeight: '600' as const },
    heading4: { fontSize: 16, fontWeight: '500' as const },
    heading5: { fontSize: 16, fontWeight: '500' as const },
    heading6: { fontSize: 16, fontWeight: '500' as const },
  };

  return (
    <View>
      {blocks.map((block, idx) => {
        if (block.type === 'text') {
          return <AliaMarkdown key={idx} content={block.content} />;
        } else if (block.type === 'block' && block.blockType) {
          return renderBlock(block.blockType, block.data, idx);
        }
        return null;
      })}
    </View>
  );
}

import React, { useMemo } from "react";
import { View } from "react-native";
import { ClarityMarkdown } from '@/lib/sdk';
import { useColorScheme } from "@/lib/useColorScheme";
import {
  CompactList,
  Banner,
  Comparison,
  Timeline,
  RichImage,
  Credibility,
} from "./rich-blocks";

// Parse special blocks from content
function parseSpecialBlocks(content: string): Array<{ type: 'text' | 'block'; content: string; blockType?: string; data?: any }> {
  const blocks: Array<{ type: 'text' | 'block'; content: string; blockType?: string; data?: any }> = [];

  const patterns = [
    { name: 'COMPACTLIST', regex: /\[(?:CLARITY_)?COMPACTLIST title="([^"]+)"\]([\s\S]*?)\[\/(?:CLARITY_)?COMPACTLIST\]/g },
    { name: 'BANNER', regex: /\[(?:CLARITY_)?BANNER type="([^"]+)" title="([^"]+)"\]([\s\S]*?)\[\/(?:CLARITY_)?BANNER\]/g },
    { name: 'COMPARISON', regex: /\[(?:CLARITY_)?COMPARISON title="([^"]+)"\]([\s\S]*?)\[\/(?:CLARITY_)?COMPARISON\]/g },
    { name: 'TIMELINE', regex: /\[(?:CLARITY_)?TIMELINE title="([^"]+)"\]([\s\S]*?)\[\/(?:CLARITY_)?TIMELINE\]/g },
    { name: 'IMAGE', regex: /\[(?:CLARITY_)?IMAGE url="([^"]+)"(?:\s+title="([^"]*)")?\s*(?:caption="([^"]*)")?\s*\/\]/g },
    { name: 'CREDIBILITY', regex: /\[(?:CLARITY_)?CREDIBILITY level="(\d+)" source="([^"]+)"\s*\/\]/g },
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
  const { colors } = useColorScheme();
  const blocks = useMemo(() => parseSpecialBlocks(content), [content]);

  const clarityColors = useMemo(() => ({
    text: colors.foreground,
    border: colors.border,
    muted: colors.muted,
    mutedForeground: colors.mutedForeground,
    primary: colors.primary,
  }), [colors.foreground, colors.border, colors.muted, colors.mutedForeground, colors.primary]);

  return (
    <View>
      {blocks.map((block, idx) => {
        if (block.type === 'text') {
          return <ClarityMarkdown key={idx} content={block.content} colors={clarityColors} />;
        } else if (block.type === 'block' && block.blockType) {
          return renderBlock(block.blockType, block.data, idx);
        }
        return null;
      })}
    </View>
  );
}

import React, { useMemo } from "react";
import { Platform, Pressable, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { AliaMarkdown } from '@alia.onl/sdk';
import { fontFamilies } from "@oxy.so/bloom/fonts";
import { useColorScheme } from "@/lib/useColorScheme";
import { Text } from "@/components/ui/text";
import { useTranslation } from "@/lib/hooks/use-translation";
import {
  extractCitationSources,
  linkifyCitations,
  splitReferences,
  type CitationSource,
  type ReferenceEntry,
} from "@/lib/citations";
import type { ToolInvocation } from "@/lib/types/messages";

import {
  CompactList,
  Banner,
  Comparison,
  Timeline,
  RichImage,
  Credibility,
} from "./rich-blocks";

/**
 * The body face for `AliaMarkdown`, which cannot inherit one on native.
 *
 * `react-native-markdown-display` is driven by RN STYLE OBJECTS and supports no
 * `className`, so NativeWind's `--font-sans` cannot reach the `<Text>` elements
 * it renders. And Bloom's app-wide native default — the `Text.defaultProps`
 * mutation in its `FontLoader.native.tsx` — does not apply: React 19 drops
 * `defaultProps` under the automatic JSX runtime Expo compiles to, measured on
 * react@19.2.3 for function and class components alike. So the family has to be
 * handed over explicitly, and this is the only surface in the app that needs it.
 *
 * Taken from Bloom's own token rather than written out, so the family has one
 * owner. `fontFamilies.sans` is a CSS STACK and RN's `fontFamily` takes a single
 * family, hence the leading entry. Web is left undefined on purpose: there the
 * cascade from `html` already carries `--bloom-font-sans`, and naming a family
 * would override Bloom instead of complementing it.
 */
export const MARKDOWN_BODY_FONT =
  Platform.OS === 'web' ? undefined : fontFamilies.sans.split(',')[0].trim();

// Cheap pre-check: plain markdown (the overwhelmingly common case) skips the
// six per-pattern regex scans below with a single pass.
const SPECIAL_BLOCK_HINT_RE = /\[(?:ALIA_)?(?:COMPACTLIST|BANNER|COMPARISON|TIMELINE|IMAGE|CREDIBILITY)/;

// Parse special blocks from content
function parseSpecialBlocks(content: string): Array<{ type: 'text' | 'block'; content: string; blockType?: string; data?: any }> {
  if (!SPECIAL_BLOCK_HINT_RE.test(content)) {
    return [{ type: 'text', content }];
  }

  const blocks: Array<{ type: 'text' | 'block'; content: string; blockType?: string; data?: any }> = [];

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

/** Open a source the way the Sources tab does: a new tab on web, the in-app browser on native. */
function openSource(url: string): void {
  if (Platform.OS === 'web') {
    window.open(url, '_blank', 'noopener,noreferrer');
  } else {
    void WebBrowser.openBrowserAsync(url);
  }
}

/**
 * The references section of a research answer, as links.
 *
 * The API now writes each entry as a Markdown link, and the SDK's renderer
 * would make those pressable on its own — but not ACCESSIBLE: its link rule
 * is a `Text` with `onPress`, which a screen reader reads as text and a
 * keyboard cannot reach. So the section is cut off the Markdown and drawn
 * here, one `accessibilityRole="link"` per entry — an `<a href>` on web, so
 * Tab reaches it and Enter opens it — named "Source n: title". Older answers,
 * whose entries were a title over a bare URL, split the same way.
 */
function ReferenceList({
  entries,
  onCitationPress,
}: {
  entries: ReferenceEntry[];
  onCitationPress?: (source: CitationSource) => void;
}) {
  const { t } = useTranslation();
  return (
    <View className="mt-3 gap-1 border-t border-border pt-3" accessibilityRole="list">
      <Text className="text-xs font-medium text-muted-foreground">{t("thought.references")}</Text>
      {entries.map((entry) => {
        const press = () => {
          if (onCitationPress) onCitationPress(entry);
          else openSource(entry.url);
        };
        // On web the anchor itself navigates (new tab, no opener); `onPress`
        // is wired only when the caller wants the press instead of the
        // navigation, and the default is then prevented.
        const webAnchor =
          Platform.OS === 'web'
            ? ({ href: entry.url, hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } } as object)
            : {};
        const onPress =
          Platform.OS === 'web'
            ? onCitationPress
              ? (e: { preventDefault?: () => void }) => { e.preventDefault?.(); press(); }
              : undefined
            : press;
        return (
          <Pressable
            key={entry.id}
            accessibilityRole="link"
            accessibilityLabel={t("thought.sourceLabel", { n: entry.id, title: entry.title })}
            className="flex-row items-start gap-2 rounded-md py-0.5 active:opacity-70"
            onPress={onPress}
            {...webAnchor}
          >
            <Text className="text-sm text-muted-foreground">[{entry.id}]</Text>
            <Text className="flex-1 text-sm text-primary underline" numberOfLines={2}>{entry.title}</Text>
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>{entry.domain}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The chat's Markdown, plus what a research answer needs on top of it.
 *
 * `toolInvocations` (the message's persisted record) and `researchSources`
 * (the live progress event, before persistence) are where the `[n]` markers
 * resolve: a marker naming a known source becomes a link to it, titled
 * "Source n: title", and the References section becomes the accessible list
 * above. Markers the model spelled as `【n†…】` or `[n, m]` in an older answer
 * are normalised first. A message with neither prop renders exactly as
 * before.
 *
 * `onCitationPress` replaces opening the URL for the references list. The
 * inline markers are rendered by the SDK's link rule, which opens the URL
 * itself and offers no hook, so they do not reach it.
 */
export function CustomMarkdown({
  content,
  toolInvocations,
  researchSources,
  onCitationPress,
}: {
  content: string;
  toolInvocations?: ToolInvocation[];
  researchSources?: Array<{ id: number; url: string; title: string }> | null;
  onCitationPress?: (source: CitationSource) => void;
}) {
  const { colors } = useColorScheme();
  const sources = useMemo(
    () => extractCitationSources(toolInvocations, researchSources),
    [toolInvocations, researchSources],
  );
  const { body, references } = useMemo(() => splitReferences(content, sources), [content, sources]);
  const linked = useMemo(() => linkifyCitations(body, sources), [body, sources]);
  const blocks = useMemo(() => parseSpecialBlocks(linked), [linked]);

  const aliaColors = useMemo(() => ({
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
          return <AliaMarkdown key={idx} content={block.content} colors={aliaColors} fontFamily={MARKDOWN_BODY_FONT} />;
        } else if (block.type === 'block' && block.blockType) {
          return renderBlock(block.blockType, block.data, idx);
        }
        return null;
      })}
      {references ? <ReferenceList entries={references} onCitationPress={onCitationPress} /> : null}
    </View>
  );
}

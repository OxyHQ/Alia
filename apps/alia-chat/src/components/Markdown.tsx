import React, { useMemo } from 'react';
import { View, Text, Platform, Linking } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { useAliaColors, type AliaColors } from '../theme';

const BODY_TEXT = { fontSize: 16, lineHeight: 28 } as const;
const HEADING_TEXT = { fontSize: 16, lineHeight: 22 } as const;
const SANS_FONT = Platform.select({ ios: 'Inter', android: 'Inter', default: 'Inter, sans-serif' })!;
const MONO_FONT = Platform.select({ ios: 'Courier', android: 'monospace', default: 'monospace' })!;

function createRules(colors: AliaColors) {
  const { text: textColor, muted, border, primary, mutedForeground } = colors;

  return {
    heading1: (node: any, children: any) => (
      <Text
        key={node.key}
        style={{ marginBottom: 8, marginTop: 12, fontSize: 18, fontWeight: '600', lineHeight: 24, color: textColor }}
      >
        {children}
      </Text>
    ),
    heading2: (node: any, children: any) => (
      <Text
        key={node.key}
        style={{ marginBottom: 8, marginTop: 12, ...HEADING_TEXT, fontWeight: '600', color: textColor }}
      >
        {children}
      </Text>
    ),
    heading3: (node: any, children: any) => (
      <Text
        key={node.key}
        style={{ marginBottom: 6, marginTop: 8, ...HEADING_TEXT, fontWeight: '600', color: textColor }}
      >
        {children}
      </Text>
    ),
    heading4: (node: any, children: any) => (
      <Text
        key={node.key}
        style={{ marginBottom: 6, marginTop: 8, ...HEADING_TEXT, fontWeight: '500', color: textColor }}
      >
        {children}
      </Text>
    ),
    heading5: (node: any, children: any) => (
      <Text
        key={node.key}
        style={{ marginBottom: 4, marginTop: 8, ...HEADING_TEXT, fontWeight: '500', color: textColor }}
      >
        {children}
      </Text>
    ),
    heading6: (node: any, children: any) => (
      <Text
        key={node.key}
        style={{ marginBottom: 4, marginTop: 8, ...HEADING_TEXT, fontWeight: '500', color: textColor }}
      >
        {children}
      </Text>
    ),
    code: (node: any, children: any, parent: any) => {
      return parent.length > 1 ? (
        <View
          key={node.key}
          style={{
            marginVertical: 8,
            overflow: 'hidden',
            borderRadius: 6,
            backgroundColor: muted,
            borderWidth: 1,
            borderColor: border,
            padding: 12,
          }}
        >
          <Text style={{ fontSize: 13, fontFamily: MONO_FONT }}>{children}</Text>
        </View>
      ) : (
        <Text
          key={node.key}
          style={{
            backgroundColor: muted,
            paddingHorizontal: 4,
            paddingVertical: 1,
            fontSize: 13,
            fontFamily: MONO_FONT,
            borderRadius: 3,
          }}
        >
          {children}
        </Text>
      );
    },
    list_item: (node: any, children: any, parent: any) => {
      const isOrdered = parent[parent.length - 1]?.type === 'ordered_list';
      const bullet = isOrdered
        ? `${parent[parent.length - 1].children.indexOf(node) + 1}.`
        : '\u2022';

      return (
        <View key={node.key} style={{ flexDirection: 'row', paddingVertical: 2, paddingLeft: 16 }}>
          <Text style={{ marginRight: 8, minWidth: 14, ...BODY_TEXT, color: mutedForeground }}>{bullet}</Text>
          <Text style={{ flex: 1, ...BODY_TEXT, color: textColor }}>{children}</Text>
        </View>
      );
    },
    ordered_list: (node: any, children: any) => (
      <View key={node.key} style={{ marginVertical: 8 }}>{children}</View>
    ),
    unordered_list: (node: any, children: any) => (
      <View key={node.key} style={{ marginVertical: 8 }}>{children}</View>
    ),
    strong: (node: any, children: any) => (
      <Text key={node.key} style={{ fontWeight: '600', ...BODY_TEXT, color: textColor }}>{children}</Text>
    ),
    link: (node: any, children: any) => (
      <Text
        key={node.key}
        style={{ color: primary, textDecorationLine: 'underline', ...BODY_TEXT }}
        onPress={() => {
          if (node.attributes?.href) Linking.openURL(node.attributes.href);
        }}
      >
        {children}
      </Text>
    ),
    paragraph: (node: any, children: any) => (
      <Text key={node.key} style={{ marginBottom: 8, ...BODY_TEXT, color: textColor }}>{children}</Text>
    ),
    blockquote: (node: any, children: any) => (
      <View
        key={node.key}
        style={{
          marginVertical: 8,
          borderLeftWidth: 4,
          borderLeftColor: border,
          backgroundColor: muted,
          paddingHorizontal: 12,
          paddingVertical: 4,
          borderTopRightRadius: 6,
          borderBottomRightRadius: 6,
        }}
      >
        {children}
      </View>
    ),
    hr: (node: any) => (
      <View
        key={node.key}
        style={{
          marginVertical: 16,
          height: 1,
          backgroundColor: border,
        }}
      />
    ),
    body: (node: any, children: any) => {
      return <View key={node.key}>{children}</View>;
    },
  };
}

function createStyles(colors: AliaColors) {
  const { text: textColor, muted, border, primary, mutedForeground } = colors;

  return {
    body: { ...BODY_TEXT, color: textColor, fontFamily: SANS_FONT },
    text: { ...BODY_TEXT, color: textColor, fontFamily: SANS_FONT },
    paragraph: { marginTop: 0, marginBottom: 8 },
    strong: { fontWeight: '600' as const },
    em: { fontStyle: 'italic' as const },
    s: { textDecorationLine: 'line-through' as const },
    bullet_list_icon: { marginLeft: 0, marginRight: 8, ...BODY_TEXT, color: mutedForeground },
    ordered_list_icon: { marginLeft: 0, marginRight: 8, ...BODY_TEXT, color: mutedForeground },
    bullet_list_content: { flex: 1 },
    ordered_list_content: { flex: 1 },
    code_inline: {
      fontSize: 13,
      fontFamily: MONO_FONT,
      backgroundColor: muted,
      borderWidth: 0,
      borderRadius: 3,
      paddingHorizontal: 4,
      paddingVertical: 1,
    },
    code_block: {
      fontSize: 13,
      fontFamily: MONO_FONT,
      backgroundColor: muted,
      borderWidth: 1,
      borderColor: border,
      borderRadius: 6,
      padding: 12,
    },
    fence: {
      fontSize: 13,
      fontFamily: MONO_FONT,
      backgroundColor: muted,
      borderWidth: 1,
      borderColor: border,
      borderRadius: 6,
      padding: 12,
    },
    table: { borderWidth: 1, borderColor: border, borderRadius: 12, marginVertical: 8, overflow: 'hidden' as const },
    thead: { backgroundColor: muted },
    th: { flex: 1, padding: 8, fontWeight: '600' as const, ...BODY_TEXT, color: textColor },
    td: { flex: 1, padding: 8, ...BODY_TEXT, color: textColor },
    tr: { borderBottomWidth: 1, borderColor: border, flexDirection: 'row' as const },
    link: { textDecorationLine: 'underline' as const, color: primary, ...BODY_TEXT },
    hr: { backgroundColor: border, height: 1, marginVertical: 16 },
    heading1: { fontSize: 18, fontWeight: '600' as const },
    heading2: { ...HEADING_TEXT, fontWeight: '600' as const },
    heading3: { ...HEADING_TEXT, fontWeight: '600' as const },
    heading4: { ...HEADING_TEXT, fontWeight: '500' as const },
    heading5: { ...HEADING_TEXT, fontWeight: '500' as const },
    heading6: { ...HEADING_TEXT, fontWeight: '500' as const },
  };
}

export interface AliaMarkdownProps {
  content: string;
  colors?: Partial<AliaColors>;
}

export function AliaMarkdown({ content, colors: colorOverrides }: AliaMarkdownProps) {
  const defaultColors = useAliaColors();
  const colors = colorOverrides ? { ...defaultColors, ...colorOverrides } : defaultColors;

  const customRules = useMemo(() => createRules(colors), [colors.text, colors.muted, colors.border, colors.primary, colors.mutedForeground]);
  const markdownStyles = useMemo(() => createStyles(colors), [colors.text, colors.muted, colors.border, colors.primary, colors.mutedForeground]);

  return <Markdown rules={customRules} style={markdownStyles}>{content}</Markdown>;
}

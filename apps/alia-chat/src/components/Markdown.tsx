import React from 'react';
import { View, Text, Platform, Linking } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { useAliaColors } from '../theme';

function createRules(isDark: boolean, textColor: string, monoFont: string) {
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
        style={{ marginBottom: 8, marginTop: 12, fontWeight: '600', lineHeight: 22, color: textColor }}
      >
        {children}
      </Text>
    ),
    heading3: (node: any, children: any) => (
      <Text
        key={node.key}
        style={{ marginBottom: 6, marginTop: 8, fontWeight: '600', lineHeight: 22, color: textColor }}
      >
        {children}
      </Text>
    ),
    heading4: (node: any, children: any) => (
      <Text
        key={node.key}
        style={{ marginBottom: 6, marginTop: 8, fontWeight: '500', lineHeight: 22, color: textColor }}
      >
        {children}
      </Text>
    ),
    heading5: (node: any, children: any) => (
      <Text
        key={node.key}
        style={{ marginBottom: 4, marginTop: 8, fontWeight: '500', lineHeight: 22, color: textColor }}
      >
        {children}
      </Text>
    ),
    heading6: (node: any, children: any) => (
      <Text
        key={node.key}
        style={{ marginBottom: 4, marginTop: 8, fontWeight: '500', lineHeight: 22, color: textColor }}
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
            backgroundColor: isDark ? '#18181b' : '#f4f4f5',
            borderWidth: 1,
            borderColor: isDark ? '#3f3f46' : '#e4e4e7',
            padding: 12,
          }}
        >
          <Text style={{ fontSize: 13, fontFamily: monoFont }}>{children}</Text>
        </View>
      ) : (
        <Text
          key={node.key}
          style={{
            backgroundColor: isDark ? '#27272a' : '#f4f4f5',
            paddingHorizontal: 4,
            paddingVertical: 1,
            fontSize: 13,
            fontFamily: monoFont,
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
          <Text style={{ marginRight: 8, minWidth: 14, color: '#71717A' }}>{bullet}</Text>
          <Text style={{ flex: 1, color: textColor }}>{children}</Text>
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
      <Text key={node.key} style={{ fontWeight: '600', color: textColor }}>{children}</Text>
    ),
    link: (node: any, children: any) => (
      <Text
        key={node.key}
        style={{ color: isDark ? '#60a5fa' : '#2563eb', textDecorationLine: 'underline' }}
        onPress={() => {
          if (node.attributes?.href) Linking.openURL(node.attributes.href);
        }}
      >
        {children}
      </Text>
    ),
    paragraph: (node: any, children: any) => (
      <Text key={node.key} style={{ marginBottom: 8, color: textColor }}>{children}</Text>
    ),
    blockquote: (node: any, children: any) => (
      <View
        key={node.key}
        style={{
          marginVertical: 8,
          borderLeftWidth: 4,
          borderLeftColor: isDark ? '#52525b' : '#d4d4d8',
          backgroundColor: isDark ? 'rgba(39,39,42,0.5)' : 'rgba(244,244,245,0.5)',
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
          backgroundColor: isDark ? '#3f3f46' : '#d4d4d8',
        }}
      />
    ),
    text: (node: any) => {
      return node.content;
    },
    body: (node: any, children: any) => {
      return <View key={node.key}>{children}</View>;
    },
  };
}

export function AliaMarkdown({ content }: { content: string }) {
  const colors = useAliaColors();
  const isDark = colors.isDark;

  const textColor = isDark ? '#ffffff' : '#0a0a0a';
  const sansFont = Platform.select({ ios: 'Inter', android: 'Inter', default: 'Inter, sans-serif' });
  const monoFont = Platform.select({ ios: 'Courier', android: 'monospace', default: 'monospace' });

  const customRules = createRules(isDark, textColor, monoFont);

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
      backgroundColor: isDark ? '#27272a' : '#f4f4f5',
      borderWidth: 0,
      borderRadius: 3,
      paddingHorizontal: 4,
      paddingVertical: 1,
    },
    code_block: {
      fontSize: 13,
      fontFamily: monoFont,
      backgroundColor: isDark ? '#18181b' : '#f4f4f5',
      borderWidth: 1,
      borderColor: isDark ? '#3f3f46' : '#e4e4e7',
      borderRadius: 6,
      padding: 12,
    },
    fence: {
      fontSize: 13,
      fontFamily: monoFont,
      backgroundColor: isDark ? '#18181b' : '#f4f4f5',
      borderWidth: 1,
      borderColor: isDark ? '#3f3f46' : '#e4e4e7',
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
      color: isDark ? '#60a5fa' : '#2563eb',
      fontSize: 16,
      lineHeight: 28,
    },
    hr: {
      backgroundColor: isDark ? '#3f3f46' : '#d4d4d8',
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

  return <Markdown rules={customRules} style={markdownStyles}>{content}</Markdown>;
}

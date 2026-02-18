import React, { useState } from "react";
import { View, ScrollView, Pressable, type ViewProps } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { Copy, Check } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
// @ts-expect-error - no type declarations available
import SyntaxHighlighter from "react-native-syntax-highlighter";
// @ts-expect-error - no type declarations available
import { atomOneLight } from "react-syntax-highlighter/styles/hljs";

// --- CodeBlock (root container) ---

export type CodeBlockProps = ViewProps;

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  return (
    <View
      className={cn(
        "w-full overflow-hidden rounded-xl border border-border bg-card",
        className
      )}
      {...props}
    >
      {children}
    </View>
  );
}

// --- CodeBlockCode (highlighted content) ---

export type CodeBlockCodeProps = {
  code: string;
  language?: string;
  className?: string;
};

function CodeBlockCode({
  code,
  language = "tsx",
  className,
}: CodeBlockCodeProps) {
  if (!code) {
    return (
      <View className={cn("p-4", className)}>
        <Text className="text-sm text-foreground" style={{ fontFamily: "monospace" }}>
          {" "}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} className={cn("", className)}>
      <SyntaxHighlighter
        language={language}
        style={atomOneLight}
        fontSize={13}
        highlighter="hljs"
        customStyle={{
          backgroundColor: "transparent",
          padding: 16,
          margin: 0,
        }}
      >
        {code}
      </SyntaxHighlighter>
    </ScrollView>
  );
}

// --- CodeBlockGroup (header/footer bar) ---

export type CodeBlockGroupProps = ViewProps & {
  language?: string;
  code?: string;
};

function CodeBlockGroup({
  children,
  className,
  language,
  code,
  ...props
}: CodeBlockGroupProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (code) {
      await Clipboard.setStringAsync(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <View
      className={cn(
        "flex-row items-center justify-between border-b border-border px-4 py-2",
        className
      )}
      {...props}
    >
      {children ?? (
        <>
          {language && (
            <Text className="text-xs text-muted-foreground">{language}</Text>
          )}
          {code && (
            <Pressable
              onPress={handleCopy}
              className="p-1 rounded active:bg-accent web:hover:bg-accent"
            >
              {copied ? (
                <Check size={14} className="text-green-500" />
              ) : (
                <Copy size={14} className="text-muted-foreground" />
              )}
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}

export { CodeBlock, CodeBlockCode, CodeBlockGroup };

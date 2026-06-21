import React, { createContext, useContext, useState } from "react";
import { View, Pressable, Linking } from "react-native";
import { Text } from "@/components/ui/text";
import { Image } from "expo-image";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

// --- Context ---

const SourceContext = createContext<{
  href: string;
  domain: string;
} | null>(null);

function useSourceContext() {
  const ctx = useContext(SourceContext);
  if (!ctx) throw new Error("Source.* must be used inside <Source>");
  return ctx;
}

// --- Source (root) ---

export type SourceProps = {
  href: string;
  children: React.ReactNode;
};

export function Source({ href, children }: SourceProps) {
  let domain = "";
  try {
    domain = new URL(href).hostname;
  } catch {
    domain = href.split("/").pop() || href;
  }

  return (
    <SourceContext.Provider value={{ href, domain }}>
      <Collapsible>{children}</Collapsible>
    </SourceContext.Provider>
  );
}

// --- SourceTrigger ---

export type SourceTriggerProps = {
  label?: string | number;
  showFavicon?: boolean;
  className?: string;
};

export function SourceTrigger({
  label,
  showFavicon = false,
  className,
}: SourceTriggerProps) {
  const { href, domain } = useSourceContext();
  const displayLabel = label ?? domain.replace("www.", "");

  return (
    <CollapsibleTrigger asChild>
      <Pressable
        className={cn(
          "flex-row items-center gap-1 rounded-full bg-muted px-1 h-5 overflow-hidden",
          showFavicon && "pl-1 pr-2",
          "web:hover:bg-muted-foreground/30 active:bg-muted-foreground/30",
          className
        )}
        onLongPress={() => Linking.openURL(href)}
      >
        {showFavicon && (
          <Image
            source={{
              uri: `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(href)}`,
            }}
            style={{ width: 14, height: 14, borderRadius: 7 }}
          />
        )}
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {displayLabel}
        </Text>
      </Pressable>
    </CollapsibleTrigger>
  );
}

// --- SourceContent ---

export type SourceContentProps = {
  title: string;
  description: string;
  className?: string;
};

export function SourceContent({
  title,
  description,
  className,
}: SourceContentProps) {
  const { href, domain } = useSourceContext();

  return (
    <CollapsibleContent>
      <Pressable
        onPress={() => Linking.openURL(href)}
        className={cn(
          "mt-2 rounded-xl border border-border bg-card p-3 gap-2",
          "active:opacity-80",
          className
        )}
      >
        <View className="flex-row items-center gap-1.5">
          <Image
            source={{
              uri: `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(href)}`,
            }}
            style={{ width: 16, height: 16, borderRadius: 8 }}
          />
          <Text className="text-sm text-primary" numberOfLines={1}>
            {domain.replace("www.", "")}
          </Text>
        </View>
        <Text className="text-sm font-medium text-foreground" numberOfLines={2}>
          {title}
        </Text>
        <Text className="text-sm text-muted-foreground" numberOfLines={2}>
          {description}
        </Text>
      </Pressable>
    </CollapsibleContent>
  );
}

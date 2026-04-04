import React from 'react';
import { View as RNView, Linking, Pressable as RNPressable } from 'react-native';
import { Image } from 'expo-image';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { ExternalLink, Info, CheckCircle, AlertTriangle, XCircle } from 'lucide-react-native';
import { cssInterop } from 'nativewind';

// Create styled components that support className
const View = cssInterop(RNView, { className: 'style' });
const Pressable = cssInterop(RNPressable, { className: 'style' });

// COMPACTLIST Component
type CompactListItem = {
  title: string;
  href?: string;
  meta?: string;
  image?: string;
};

export function CompactList({ title, items }: { title: string; items: CompactListItem[] }) {
  return (
    <View className="my-2 rounded-lg border border-border bg-surface p-3">
      <Text className="font-semibold mb-2">{title}</Text>
      <View className="gap-1.5">
        {items.map((item, idx) => (
          <Pressable
            key={idx}
            className="flex-row items-start gap-2.5 rounded-md border border-border dark:border-zinc-700 bg-background p-2.5 active:bg-muted/50"
            onPress={() => item.href && Linking.openURL(item.href)}
          >
            {item.image && (
              <Image
                source={{ uri: item.image }}
                className="h-10 w-10 rounded"
                contentFit="cover"
                placeholder={{ blurhash: 'L6PZfSi_.AyE_3t7t7R**0o#DgR4' }}
                transition={200}
              />
            )}
            <View className="flex-1">
              <Text className="font-medium">{item.title}</Text>
              {item.meta && (
                <Text className="text-sm text-muted-foreground mt-0.5">{item.meta}</Text>
              )}
            </View>
            {item.href && <ExternalLink size={14} className="text-muted-foreground" />}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// BANNER Component
type BannerType = 'info' | 'success' | 'warning' | 'danger';

const BANNER_CONFIG: Record<BannerType, { icon: any; bgColor: string; textColor: string; borderColor: string }> = {
  info: {
    icon: Info,
    bgColor: 'bg-blue-50 dark:bg-blue-950/30',
    textColor: 'text-blue-900 dark:text-blue-100',
    borderColor: 'border-blue-200 dark:border-blue-800',
  },
  success: {
    icon: CheckCircle,
    bgColor: 'bg-green-50 dark:bg-green-950/30',
    textColor: 'text-green-900 dark:text-green-100',
    borderColor: 'border-green-200 dark:border-green-800',
  },
  warning: {
    icon: AlertTriangle,
    bgColor: 'bg-yellow-50 dark:bg-yellow-950/30',
    textColor: 'text-yellow-900 dark:text-yellow-100',
    borderColor: 'border-yellow-200 dark:border-yellow-800',
  },
  danger: {
    icon: XCircle,
    bgColor: 'bg-red-50 dark:bg-red-950/30',
    textColor: 'text-red-900 dark:text-red-100',
    borderColor: 'border-red-200 dark:border-red-800',
  },
};

export function Banner({ type = 'info', title, content }: { type?: BannerType; title: string; content: string }) {
  const config = BANNER_CONFIG[type];
  const Icon = config.icon;

  return (
    <View className={cn('my-2 rounded-lg border p-3', config.bgColor, config.borderColor)}>
      <View className="flex-row items-start gap-2.5">
        <Icon size={18} className={config.textColor} />
        <View className="flex-1">
          <Text className={cn('font-semibold mb-1', config.textColor)}>{title}</Text>
          <Text className={cn('text-base', config.textColor)}>{content}</Text>
        </View>
      </View>
    </View>
  );
}

// COMPARISON Component
type ComparisonSide = {
  title: string;
  content: string;
  source?: string;
  tone?: 'info' | 'success' | 'warning' | 'danger';
};

export function Comparison({
  title,
  left,
  right,
  conclusion,
}: {
  title: string;
  left: ComparisonSide;
  right: ComparisonSide;
  conclusion?: string;
}) {
  const getToneColor = (tone?: string) => {
    switch (tone) {
      case 'success': return 'border-green-500/50';
      case 'warning': return 'border-yellow-500/50';
      case 'danger': return 'border-red-500/50';
      default: return 'border-blue-500/50';
    }
  };

  return (
    <View className="my-2 rounded-lg border border-border bg-surface p-3">
      <Text className="font-semibold mb-2">{title}</Text>
      <View className="gap-2">
        <View className={cn('rounded-md border-l-4 bg-zinc-50 dark:bg-zinc-800/50 p-2.5', getToneColor(left.tone))}>
          <Text className="font-medium mb-1">{left.title}</Text>
          <Text className="text-base text-muted-foreground">{left.content}</Text>
          {left.source && (
            <Text className="text-sm text-muted-foreground mt-1 italic">Source: {left.source}</Text>
          )}
        </View>
        <View className={cn('rounded-md border-l-4 bg-zinc-50 dark:bg-zinc-800/50 p-2.5', getToneColor(right.tone))}>
          <Text className="font-medium mb-1">{right.title}</Text>
          <Text className="text-base text-muted-foreground">{right.content}</Text>
          {right.source && (
            <Text className="text-sm text-muted-foreground mt-1 italic">Source: {right.source}</Text>
          )}
        </View>
        {conclusion && (
          <View className="rounded-md bg-primary/10 p-2.5">
            <Text className="font-medium">{conclusion}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

// TIMELINE Component
type TimelineItem = {
  date: string;
  title: string;
  description?: string;
};

export function Timeline({ title, items }: { title: string; items: TimelineItem[] }) {
  return (
    <View className="my-2 rounded-lg border border-border bg-surface p-3">
      <Text className="font-semibold mb-2">{title}</Text>
      <View className="gap-2.5">
        {items.map((item, idx) => (
          <View key={idx} className="flex-row gap-2.5">
            <View className="items-center">
              <View className="h-2.5 w-2.5 rounded-full bg-primary" />
              {idx < items.length - 1 && (
                <View className="w-0.5 flex-1 bg-zinc-300 dark:bg-zinc-600 mt-1" style={{ minHeight: 32 }} />
              )}
            </View>
            <View className="flex-1 pb-1">
              <Text className="text-sm text-muted-foreground mb-0.5">{item.date}</Text>
              <Text className="font-medium">{item.title}</Text>
              {item.description && (
                <Text className="text-base text-muted-foreground mt-0.5">{item.description}</Text>
              )}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

// IMAGE Component
export function RichImage({ url, title, caption }: { url: string; title?: string; caption?: string }) {
  return (
    <View className="my-2">
      <Image
        source={{ uri: url }}
        className="w-full rounded-lg"
        style={{ aspectRatio: 16 / 9 }}
        contentFit="cover"
      />
      {title && (
        <Text className="font-medium mt-1.5">{title}</Text>
      )}
      {caption && (
        <Text className="text-sm text-muted-foreground mt-0.5">{caption}</Text>
      )}
    </View>
  );
}

// CREDIBILITY Component
export function Credibility({ level, source }: { level: number; source: string }) {
  const getColor = () => {
    if (level >= 4) return 'bg-green-500';
    if (level >= 3) return 'bg-blue-500';
    if (level >= 2) return 'bg-yellow-500';
    return 'bg-red-500';
  };

  return (
    <View className="my-2 flex-row items-center gap-2">
      <View className="flex-row gap-1">
        {[1, 2, 3, 4, 5].map((i) => (
          <View
            key={i}
            className={cn(
              'h-1.5 w-7 rounded-full',
              i <= level ? getColor() : 'bg-zinc-300 dark:bg-zinc-600'
            )}
          />
        ))}
      </View>
      <Text className="text-sm text-muted-foreground">
        Source: {source}
      </Text>
    </View>
  );
}

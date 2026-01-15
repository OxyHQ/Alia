import React from 'react';
import { View, Linking, Pressable, Image } from 'react-native';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { ExternalLink, Info, CheckCircle, AlertTriangle, XCircle } from 'lucide-react-native';

// COMPACTLIST Component
type CompactListItem = {
  title: string;
  href?: string;
  meta?: string;
  image?: string;
};

export function CompactList({ title, items }: { title: string; items: CompactListItem[] }) {
  return (
    <View className="my-4 rounded-xl border border-border bg-card p-4">
      <Text className="text-base font-semibold text-foreground mb-3">{title}</Text>
      <View className="gap-2">
        {items.map((item, idx) => (
          <Pressable
            key={idx}
            className="flex-row items-start gap-3 rounded-lg border border-border bg-background p-3 active:bg-muted/50"
            onPress={() => item.href && Linking.openURL(item.href)}
          >
            {item.image && (
              <Image
                source={{ uri: item.image }}
                className="h-12 w-12 rounded-md"
                resizeMode="cover"
              />
            )}
            <View className="flex-1">
              <Text className="text-sm font-medium text-foreground">{item.title}</Text>
              {item.meta && (
                <Text className="text-xs text-muted-foreground mt-1">{item.meta}</Text>
              )}
            </View>
            {item.href && <ExternalLink size={16} className="text-muted-foreground" />}
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
    <View className={cn('my-4 rounded-xl border p-4', config.bgColor, config.borderColor)}>
      <View className="flex-row items-start gap-3">
        <Icon size={20} className={config.textColor} />
        <View className="flex-1">
          <Text className={cn('text-base font-semibold mb-2', config.textColor)}>{title}</Text>
          <Text className={cn('text-sm', config.textColor)}>{content}</Text>
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
    <View className="my-4 rounded-xl border border-border bg-card p-4">
      <Text className="text-base font-semibold text-foreground mb-4">{title}</Text>
      <View className="gap-3">
        <View className={cn('rounded-lg border-l-4 bg-muted/50 p-3', getToneColor(left.tone))}>
          <Text className="text-sm font-medium text-foreground mb-2">{left.title}</Text>
          <Text className="text-sm text-muted-foreground">{left.content}</Text>
          {left.source && (
            <Text className="text-xs text-muted-foreground mt-2 italic">Source: {left.source}</Text>
          )}
        </View>
        <View className={cn('rounded-lg border-l-4 bg-muted/50 p-3', getToneColor(right.tone))}>
          <Text className="text-sm font-medium text-foreground mb-2">{right.title}</Text>
          <Text className="text-sm text-muted-foreground">{right.content}</Text>
          {right.source && (
            <Text className="text-xs text-muted-foreground mt-2 italic">Source: {right.source}</Text>
          )}
        </View>
        {conclusion && (
          <View className="rounded-lg bg-primary/10 p-3 mt-1">
            <Text className="text-sm font-medium text-foreground">{conclusion}</Text>
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
    <View className="my-4 rounded-xl border border-border bg-card p-4">
      <Text className="text-base font-semibold text-foreground mb-4">{title}</Text>
      <View className="gap-4">
        {items.map((item, idx) => (
          <View key={idx} className="flex-row gap-3">
            <View className="items-center">
              <View className="h-3 w-3 rounded-full bg-primary" />
              {idx < items.length - 1 && (
                <View className="w-0.5 flex-1 bg-border mt-1" style={{ minHeight: 40 }} />
              )}
            </View>
            <View className="flex-1 pb-2">
              <Text className="text-xs text-muted-foreground mb-1">{item.date}</Text>
              <Text className="text-sm font-medium text-foreground">{item.title}</Text>
              {item.description && (
                <Text className="text-sm text-muted-foreground mt-1">{item.description}</Text>
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
    <View className="my-4">
      <Image
        source={{ uri: url }}
        className="w-full rounded-xl"
        style={{ aspectRatio: 16 / 9 }}
        resizeMode="cover"
      />
      {title && (
        <Text className="text-sm font-medium text-foreground mt-2">{title}</Text>
      )}
      {caption && (
        <Text className="text-xs text-muted-foreground mt-1">{caption}</Text>
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
    <View className="my-4 flex-row items-center gap-2">
      <View className="flex-row gap-1">
        {[1, 2, 3, 4, 5].map((i) => (
          <View
            key={i}
            className={cn(
              'h-2 w-8 rounded-full',
              i <= level ? getColor() : 'bg-muted'
            )}
          />
        ))}
      </View>
      <Text className="text-xs text-muted-foreground">
        Source: {source}
      </Text>
    </View>
  );
}

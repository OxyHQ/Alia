import { useTranslation } from '@/shared/i18n/use-translation';
import {
  Admonition,
  AdmonitionContent,
  AdmonitionIcon,
  AdmonitionRoot,
  AdmonitionRow,
  AdmonitionText,
} from '@oxy.so/bloom/admonition';
import { Card, CardBody, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons/RiExternalLinkLine';
import { Item } from '@oxy.so/bloom/item';
import { Rating } from '@oxy.so/bloom/rating';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { Image } from '@/shared/ui/image';
import { Linking, View } from 'react-native';

/**
 * The rich blocks a reply can carry (```compactlist, ```banner, …), drawn with
 * Bloom: a card per block, `Item` rows, `Admonition` for a banner and `Rating`
 * for a source's credibility. `src/features/chat/ui/markdown.tsx` parses the fences.
 */

type CompactListItem = {
  title: string;
  href?: string;
  meta?: string;
  image?: string;
};

export function CompactList({ title, items }: { title: string; items: CompactListItem[] }) {
  return (
    <Card appearance="outline" className="my-2">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardBody>
        <View role="list">
          {items.map((item, index) => (
            <Item
              key={index}
              role="listitem"
              title={item.title}
              subtitle={item.meta}
              leading={item.image ? <Image source={{ uri: item.image }} className="h-10 w-10 rounded" contentFit="cover" /> : undefined}
              trailing={item.href ? <RiExternalLinkLine size="sm" /> : undefined}
              onPress={item.href ? () => void Linking.openURL(item.href!) : undefined}
            />
          ))}
        </View>
      </CardBody>
    </Card>
  );
}

type BannerType = 'info' | 'success' | 'warning' | 'danger';

/** A block's tone, in Bloom's admonition vocabulary. */
const ADMONITION = { info: 'info', success: 'tip', warning: 'warning', danger: 'error' } as const;

export function Banner({ type = 'info', title, content }: { type?: BannerType; title: string; content: string }) {
  return (
    <View className="my-2">
      <AdmonitionRoot type={Object.hasOwn(ADMONITION, type) ? ADMONITION[type] : 'info'}>
        <AdmonitionRow>
          <AdmonitionIcon />
          <AdmonitionContent>
            <Text variant="body-medium">{title}</Text>
            <AdmonitionText>{content}</AdmonitionText>
          </AdmonitionContent>
        </AdmonitionRow>
      </AdmonitionRoot>
    </View>
  );
}

type ComparisonSide = {
  title: string;
  content: string;
  source?: string;
};

function ComparisonSideCard({ side }: { side: ComparisonSide }) {
  const { t } = useTranslation();
  return (
    <Card appearance="outline">
      <CardBody>
        <Text variant="body-medium">{side.title}</Text>
        <Muted>{side.content}</Muted>
        {side.source ? <Muted>{t('chat.richBlocks.source', { source: side.source })}</Muted> : null}
      </CardBody>
    </Card>
  );
}

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
  return (
    <Card appearance="outline" className="my-2">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardBody>
        <View className="gap-2">
          <ComparisonSideCard side={left} />
          <ComparisonSideCard side={right} />
          {conclusion ? <Admonition type="tip">{conclusion}</Admonition> : null}
        </View>
      </CardBody>
    </Card>
  );
}

type TimelineItem = {
  date: string;
  title: string;
  description?: string;
};

export function Timeline({ title, items }: { title: string; items: TimelineItem[] }) {
  return (
    <Card appearance="outline" className="my-2">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardBody>
        <View role="list">
          {items.map((item, index) => (
            <Item
              key={index}
              role="listitem"
              leading={<Muted>{item.date}</Muted>}
              title={item.title}
              subtitle={item.description}
            />
          ))}
        </View>
      </CardBody>
    </Card>
  );
}

export function RichImage({ url, title, caption }: { url: string; title?: string; caption?: string }) {
  return (
    <View className="my-2 gap-1">
      <Image source={{ uri: url }} className="aspect-video w-full rounded-lg" contentFit="cover" />
      {title ? <Text variant="body-medium">{title}</Text> : null}
      {caption ? <Muted>{caption}</Muted> : null}
    </View>
  );
}

/** How far a source can be trusted, on a five-point scale. */
export function Credibility({ level, source }: { level: number; source: string }) {
  const { t } = useTranslation();
  return (
    <View className="my-2 flex-row items-center gap-2">
      <Rating value={Math.max(0, Math.min(5, level))} size="small" />
      <Muted>{t('chat.richBlocks.source', { source })}</Muted>
    </View>
  );
}

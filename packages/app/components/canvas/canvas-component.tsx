import { useTranslation } from '@/lib/hooks/use-translation';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
import { ChartRenderer } from './chart-renderer';
import { CodeRenderer } from './code-renderer';
import { FormRenderer } from './form-renderer';
import { MarkdownRenderer } from './markdown-renderer';
import { TableRenderer } from './table-renderer';

interface CanvasComponentProps {
  component: {
    id: string;
    type: string;
    title: string;
    data: any;
  };
  onFormSubmit?: (formData: Record<string, any>) => void;
}

export function CanvasComponent({ component, onFormSubmit }: CanvasComponentProps) {
  const { t } = useTranslation();

  // Code carries its own header (the file name), and a chart card its own title.
  if (component.type === 'code') return <CodeRenderer data={component.data} filename={component.title} />;
  if (component.type === 'artifact' && component.data.language)
    return (
      <CodeRenderer
        data={{ language: component.data.language, code: component.data.content }}
        filename={component.title}
      />
    );
  if (component.type === 'chart') return <ChartRenderer data={component.data} title={component.title} />;

  const content = (() => {
    switch (component.type) {
      case 'table':
        return <TableRenderer data={component.data} title={component.title} />;
      case 'form':
        return <FormRenderer data={component.data} onSubmit={onFormSubmit} />;
      case 'image':
        return <Muted>{component.data.alt || t('panels.canvas.image')}</Muted>;
      case 'markdown':
        return <MarkdownRenderer data={component.data} />;
      case 'artifact':
        return <MarkdownRenderer data={{ content: component.data.content }} />;
      default:
        return <Muted>{t('panels.canvas.unsupported', { type: component.type })}</Muted>;
    }
  })();

  return (
    <View className="gap-3">
      <Text variant="body-semibold">{component.title}</Text>
      {content}
    </View>
  );
}

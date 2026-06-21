import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { ChartRenderer } from './chart-renderer';
import { TableRenderer } from './table-renderer';
import { CodeRenderer } from './code-renderer';
import { FormRenderer } from './form-renderer';
import { MarkdownRenderer } from './markdown-renderer';

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
  const renderContent = () => {
    switch (component.type) {
      case 'chart':
        return <ChartRenderer data={component.data} />;
      case 'table':
        return <TableRenderer data={component.data} />;
      case 'code':
        return <CodeRenderer data={component.data} />;
      case 'form':
        return <FormRenderer data={component.data} onSubmit={onFormSubmit} />;
      case 'image':
        return (
          <View className="items-center">
            <Text className="text-sm text-muted-foreground">
              {component.data.alt || 'Image'}
            </Text>
          </View>
        );
      case 'markdown':
        return <MarkdownRenderer data={component.data} />;
      case 'artifact':
        return component.data.language
          ? <CodeRenderer data={{ language: component.data.language, code: component.data.content }} />
          : <MarkdownRenderer data={{ content: component.data.content }} />;
      default:
        return (
          <Text className="text-sm text-muted-foreground">
            Unsupported component type: {component.type}
          </Text>
        );
    }
  };

  return (
    <View className="border border-border rounded-xl bg-card p-4 gap-3">
      <Text className="text-sm font-semibold text-foreground">{component.title}</Text>
      {renderContent()}
    </View>
  );
}

import { View } from 'react-native';
import { Text } from '@/components/ui/text';

interface MarkdownData {
  content: string;
}

interface MarkdownRendererProps {
  data: MarkdownData;
}

interface ParsedBlock {
  type: 'heading' | 'bullet' | 'numbered' | 'code' | 'paragraph';
  level?: number;
  content: string;
  language?: string;
}

function parseBlocks(content: string): ParsedBlock[] {
  const lines = content.split('\n');
  const blocks: ParsedBlock[] = [];
  let inCodeBlock = false;
  let codeContent = '';
  let codeLang = '';

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        blocks.push({ type: 'code', content: codeContent.trimEnd(), language: codeLang });
        codeContent = '';
        codeLang = '';
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeLang = line.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeContent += (codeContent ? '\n' : '') + line;
      continue;
    }

    if (line.trim() === '') continue;

    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, content: headingMatch[2] });
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)/);
    if (bulletMatch) {
      blocks.push({ type: 'bullet', content: bulletMatch[1] });
      continue;
    }

    const numberedMatch = line.match(/^\d+\.\s+(.+)/);
    if (numberedMatch) {
      blocks.push({ type: 'numbered', content: numberedMatch[1] });
      continue;
    }

    blocks.push({ type: 'paragraph', content: line });
  }

  return blocks;
}

function renderInlineStyles(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    if (boldMatch && boldMatch.index !== undefined) {
      if (boldMatch.index > 0) {
        parts.push(<Text key={key++} className="text-sm text-foreground">{remaining.slice(0, boldMatch.index)}</Text>);
      }
      parts.push(<Text key={key++} className="text-sm font-bold text-foreground">{boldMatch[1]}</Text>);
      remaining = remaining.slice(boldMatch.index + boldMatch[0].length);
      continue;
    }

    // Italic
    const italicMatch = remaining.match(/\*(.+?)\*/);
    if (italicMatch && italicMatch.index !== undefined) {
      if (italicMatch.index > 0) {
        parts.push(<Text key={key++} className="text-sm text-foreground">{remaining.slice(0, italicMatch.index)}</Text>);
      }
      parts.push(<Text key={key++} className="text-sm italic text-foreground">{italicMatch[1]}</Text>);
      remaining = remaining.slice(italicMatch.index + italicMatch[0].length);
      continue;
    }

    // Inline code
    const codeMatch = remaining.match(/`(.+?)`/);
    if (codeMatch && codeMatch.index !== undefined) {
      if (codeMatch.index > 0) {
        parts.push(<Text key={key++} className="text-sm text-foreground">{remaining.slice(0, codeMatch.index)}</Text>);
      }
      parts.push(
        <Text key={key++} className="text-xs bg-muted px-1 py-0.5 rounded" style={{ fontFamily: 'monospace' }}>
          {codeMatch[1]}
        </Text>
      );
      remaining = remaining.slice(codeMatch.index + codeMatch[0].length);
      continue;
    }

    parts.push(<Text key={key++} className="text-sm text-foreground">{remaining}</Text>);
    break;
  }

  return parts;
}

export function MarkdownRenderer({ data }: MarkdownRendererProps) {
  const blocks = parseBlocks(data.content);

  let numberedIndex = 0;

  return (
    <View className="gap-2">
      {blocks.map((block, i) => {
        if (block.type !== 'numbered') numberedIndex = 0;

        switch (block.type) {
          case 'heading': {
            const sizeClass = block.level === 1 ? 'text-xl' : block.level === 2 ? 'text-lg' : 'text-base';
            return (
              <Text key={i} className={`${sizeClass} font-bold text-foreground`}>
                {block.content}
              </Text>
            );
          }
          case 'bullet':
            return (
              <View key={i} className="flex-row gap-2 pl-2">
                <Text className="text-sm text-muted-foreground">{'\u2022'}</Text>
                <Text className="text-sm text-foreground flex-1">{renderInlineStyles(block.content)}</Text>
              </View>
            );
          case 'numbered': {
            numberedIndex++;
            return (
              <View key={i} className="flex-row gap-2 pl-2">
                <Text className="text-sm text-muted-foreground" style={{ minWidth: 16 }}>{numberedIndex}.</Text>
                <Text className="text-sm text-foreground flex-1">{renderInlineStyles(block.content)}</Text>
              </View>
            );
          }
          case 'code':
            return (
              <View key={i} className="rounded-lg p-3" style={{ backgroundColor: '#18181b' }}>
                <Text style={{ fontFamily: 'monospace', fontSize: 12, color: '#e4e4e7', lineHeight: 18 }}>
                  {block.content}
                </Text>
              </View>
            );
          case 'paragraph':
          default:
            return (
              <Text key={i} className="text-sm text-foreground leading-relaxed">
                {renderInlineStyles(block.content)}
              </Text>
            );
        }
      })}
    </View>
  );
}

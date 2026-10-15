import { ReplyMarkdown } from '../ReplyMarkdown';

interface MarkdownData {
  content: string;
}

interface MarkdownRendererProps {
  data: MarkdownData;
}

/** A generated document, written by the same Markdown renderer as a chat reply. */
export function MarkdownRenderer({ data }: MarkdownRendererProps) {
  return <ReplyMarkdown content={data.content} />;
}

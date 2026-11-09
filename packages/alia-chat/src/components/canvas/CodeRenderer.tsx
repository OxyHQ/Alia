import { useLabels } from '../../lib/labels';
import { CodeBlock } from '@oxy.so/bloom/code';

interface CodeData {
  language: string;
  code: string;
}

/** Shared code surface and copy feedback. */
export function CodeRenderer({ data, filename }: { data: CodeData; filename?: string }) {
  const { t } = useLabels();
  return (
    <CodeBlock
      code={data.code}
      language={data.language}
      filename={filename}
      labels={{ copy: t('panels.code.copy'), copied: t('panels.code.copied') }}
    />
  );
}

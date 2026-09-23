import { CodeBlock } from '@oxy.so/bloom/code';
import * as Clipboard from 'expo-clipboard';

interface CodeData {
  language: string;
  code: string;
}

/** Shared code surface and copy feedback; clipboard works on both platforms. */
export function CodeRenderer({
  data,
  filename,
}: {
  data: CodeData;
  filename?: string;
}) {
  return (
    <CodeBlock
      code={data.code}
      language={data.language}
      filename={filename}
      onCopy={async (code) => { await Clipboard.setStringAsync(code); }}
    />
  );
}

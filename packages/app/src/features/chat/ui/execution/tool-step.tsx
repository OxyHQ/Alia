import { useTranslation } from '@/shared/i18n/use-translation';
import type { Source, ToolCallStatus } from '@/features/chat/model/thought-utils';
import { Chip } from '@oxy.so/bloom/chip';
import { CodeBlock } from '@oxy.so/bloom/code';
import { RiArrowDownSLine } from '@oxy.so/bloom/icons/RiArrowDownSLine';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { useTheme } from '@oxy.so/bloom/theme';
import { Muted } from '@oxy.so/bloom/typography';
import * as Clipboard from 'expo-clipboard';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';

/**
 * One execution row: a tool call, its state, and — expanded — what went in
 * and what came out.
 *
 * The row is Bloom's `Item` as a disclosure (`expanded`), the two blocks are
 * Bloom's `CodeBlock`, and a search step's domains are `Chip`s. The expanded
 * block is MOUNTED only while expanded, so nothing inside a collapsed row can
 * hold focus.
 *
 * Status is read from the lifecycle, never from the row being last: a call
 * that never returned in a turn that is over reads as interrupted, and a call
 * whose result carries an error reads as an error, so an execution list never
 * says "done" about work that did not finish.
 */
export interface ToolStepProps {
  title: string;
  /** The call's argument summary, printed muted under the title. */
  description?: string;
  status: ToolCallStatus;
  /** The tool's icon, drawn in the leading slot while the call is not running. */
  icon: ReactNode;
  /** The call's arguments as text; empty hides the block. */
  input: string;
  /** The call's result as text; empty hides the block. */
  output: string;
  /** The web sources a search step returned, drawn as domain chips under the block. */
  sources?: Source[];
  expanded: boolean;
  onToggle: () => void;
}

/** How many domain chips a search step shows before it counts the rest. */
const CHIP_LIMIT = 3;

async function copy(code: string) {
  await Clipboard.setStringAsync(code);
}

export function ToolStep({
  title,
  description,
  status,
  icon,
  input,
  output,
  sources,
  expanded,
  onToggle,
}: ToolStepProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const chips = sources ? sources.slice(0, CHIP_LIMIT) : [];
  const extra = sources ? Math.max(0, sources.length - CHIP_LIMIT) : 0;
  const statusWord =
    status === 'error' ? t('thought.failed') : status === 'interrupted' ? t('thought.cancelled') : null;
  const Chevron = expanded ? RiArrowDownSLine : RiArrowRightSLine;
  const labels = { copy: t('panels.code.copy'), copied: t('panels.code.copied') };

  return (
    <View>
      <Item
        density="compact"
        leading={status === 'running' ? <Loading size="sm" iconSize={14} /> : icon}
        title={title}
        subtitle={description}
        destructive={status === 'error'}
        trailing={
          <View className="flex-row items-center gap-1.5">
            {statusWord === null ? null : <Muted>{statusWord}</Muted>}
            <Chevron size="sm" fill={colors.textSecondary} />
          </View>
        }
        expanded={expanded}
        onPress={onToggle}
        accessibilityLabel={statusWord === null ? title : `${title}, ${statusWord}`}
      />

      {expanded ? (
        <View className="gap-2 pb-2">
          {input.length > 0 || output.length > 0 ? (
            <ScrollView className="max-h-[200px]" contentContainerClassName="gap-2" nestedScrollEnabled>
              {input.length > 0 ? (
                <CodeBlock
                  code={input}
                  filename={t('thought.input')}
                  lineNumbers={false}
                  wrap
                  onCopy={copy}
                  labels={labels}
                />
              ) : null}
              {output.length > 0 ? (
                <CodeBlock
                  code={output}
                  filename={t('thought.output')}
                  lineNumbers={false}
                  wrap
                  onCopy={copy}
                  labels={labels}
                />
              ) : null}
            </ScrollView>
          ) : null}
          {chips.length > 0 ? (
            <View className="flex-row flex-wrap gap-1.5">
              {chips.map((source) => (
                <Chip key={source.url} size="sm" leadingIcon={RiGlobalLine}>
                  {source.domain}
                </Chip>
              ))}
              {extra > 0 ? <Chip size="sm">{`+ ${extra}`}</Chip> : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

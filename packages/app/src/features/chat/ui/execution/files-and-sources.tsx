import { useTranslation } from '@/shared/i18n/use-translation';
import type { OutputFile, Source } from '@/features/chat/model/thought-utils';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@oxy.so/bloom/accordion';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiFileTextLine } from '@oxy.so/bloom/icons/RiFileTextLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { Item } from '@oxy.so/bloom/item';
import { useTheme } from '@oxy.so/bloom/theme';
import { useState } from 'react';

/**
 * "Files and sources": what a turn produced and what it read, as two Bloom
 * `Accordion` sections of `Item` rows.
 *
 * An output row is pressable only when the canvas holds its artifact to open;
 * otherwise it is a labelled row and says so to assistive tech. A name is
 * truncated on screen and whole in the row's accessible label.
 *
 * An empty section stays, with its header and one muted line, so the tab can
 * never look like it failed to load and never hides that a persisted turn
 * produced nothing (#542).
 */
export interface FilesAndSourcesProps {
  outputs: OutputFile[];
  sources: Source[];
  /**
   * Whether the canvas can show an output, and — called from a press — open
   * it. Returns `true` for an output it can open, so the row is a control
   * only then; absent means no output is.
   */
  onOpenOutput?: (output: OutputFile) => boolean;
  onOpenSource: (source: Source) => void;
}

const ALL_OPEN = ['outputs', 'sources'];

export function FilesAndSources({ outputs, sources, onOpenOutput, onOpenSource }: FilesAndSourcesProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [open, setOpen] = useState<string[]>(ALL_OPEN);

  return (
    <Accordion
      type="multiple"
      value={open}
      onValueChange={(next) => setOpen(Array.isArray(next) ? next : next === undefined ? [] : [next])}
    >
      <AccordionItem value="outputs">
        <AccordionTrigger>{t('thought.outputs')}</AccordionTrigger>
        <AccordionContent>
          {outputs.length === 0 ? (
            <EmptyState variant="compact" description={t('thought.noOutputs')} />
          ) : (
            outputs.map((output) => {
              // A row is a control only when the canvas can actually show
              // the file — the caller says so per output, so a persisted
              // turn whose artifact is gone lists the name without a dead
              // button under it.
              const openable = onOpenOutput !== undefined && onOpenOutput(output);
              return (
                <Item
                  key={output.id}
                  role="listitem"
                  density="compact"
                  leading={<RiFileTextLine size="md" fill={colors.textSecondary} />}
                  title={output.name}
                  accessibilityLabel={openable ? t('thought.openOutput', { name: output.name }) : output.name}
                  onPress={openable ? () => onOpenOutput(output) : undefined}
                />
              );
            })
          )}
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="sources">
        <AccordionTrigger>{t('thought.sources')}</AccordionTrigger>
        <AccordionContent>
          {sources.length === 0 ? (
            <EmptyState variant="compact" description={t('thought.noSources')} />
          ) : (
            sources.map((source, index) => (
              <Item
                key={source.url}
                role="listitem"
                density="compact"
                leading={<RiGlobalLine size="sm" fill={colors.textSecondary} />}
                title={source.title}
                subtitle={source.domain}
                accessibilityLabel={t('thought.sourceLabel', { n: index + 1, title: source.title })}
                onPress={() => onOpenSource(source)}
              />
            ))
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

import { useLabels } from '../../lib/labels';
import type { OutputFile, Source } from '../../runtime/model';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@oxy.so/bloom/accordion';
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
  /** What the host can do with a generated file; absent, no output is pressable. */
  outputActions?: OutputActions;
  onOpenSource: (source: Source) => void;
}

/** Where a generated file opens: the host's canvas, for as long as it holds the file. */
export interface OutputActions {
  /**
   * Whether `open` can show this output. A host that keeps the files it was told about answers
   * `false` for one it no longer holds, so a reloaded thread lists the file by name with no
   * press, rather than a press that opens nothing.
   */
  canOpen: (output: OutputFile) => boolean;
  open: (output: OutputFile) => void;
}

const ALL_OPEN = ['outputs', 'sources'];

export function FilesAndSources({
  outputs,
  sources,
  outputActions,
  onOpenSource,
}: FilesAndSourcesProps) {
  const { t } = useLabels();
  const { colors } = useTheme();
  const [open, setOpen] = useState<string[]>(ALL_OPEN);

  return (
    <Accordion
      type="multiple"
      value={open}
      onValueChange={(next) =>
        setOpen(Array.isArray(next) ? next : next === undefined ? [] : [next])
      }
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
              const openable = outputActions?.canOpen(output) === true;
              return (
                <Item
                  key={output.id}
                  role="listitem"
                  density="compact"
                  leading={<RiFileTextLine size="md" fill={colors.textSecondary} />}
                  title={output.name}
                  accessibilityLabel={
                    openable ? t('thought.openOutput', { name: output.name }) : output.name
                  }
                  onPress={openable ? () => outputActions?.open(output) : undefined}
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

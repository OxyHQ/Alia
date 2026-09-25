/**
 * Creating a show SERIES — the thing episodes belong to.
 *
 * A series is a real podcast on Syra: it gets cover art, a visibility, and a
 * feed. So this asks for what a podcast needs — a title, what the show is
 * about, and who may hear it.
 *
 * The brief is the LOAD-BEARING field, and the copy beside it says so. Asking
 * for an episode says nothing about what it covers, so every episode's subject
 * is chosen from this and from the subjects earlier episodes used. A brief that
 * describes one episode gives a show that can only ever make that episode
 * again.
 */

import { useTranslation } from '@/shared/i18n/use-translation';
import {
  useShowStore,
  type ShowFormat,
  type ShowVisibility,
} from '@/features/shows/runtime/show-store';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import { Dialog } from '@oxy.so/bloom/dialog';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { RiBookOpenLine } from '@oxy.so/bloom/icons/RiBookOpenLine';
import { RiChat3Line } from '@oxy.so/bloom/icons/RiChat3Line';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { RiLink } from '@oxy.so/bloom/icons/RiLink';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { RiMic2Line } from '@oxy.so/bloom/icons/RiMic2Line';
import { RiNewspaperLine } from '@oxy.so/bloom/icons/RiNewspaperLine';
import { RiQuestionLine } from '@oxy.so/bloom/icons/RiQuestionLine';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import {
  TextFieldHint,
  TextFieldInput,
  TextFieldLabel,
} from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { useCallback, useState } from 'react';
import { ScrollView, View } from 'react-native';

/** Labels and descriptions below are i18n keys. */
const FORMATS: Array<{
  id: ShowFormat;
  label: string;
  icon: BloomIconComponent;
  description: string;
}> = [
  {
    id: 'podcast',
    label: 'shows.formatName.podcast.label',
    icon: RiMic2Line,
    description: 'shows.formatName.podcast.description',
  },
  {
    id: 'news',
    label: 'shows.formatName.news.label',
    icon: RiNewspaperLine,
    description: 'shows.formatName.news.description',
  },
  {
    id: 'debate',
    label: 'shows.formatName.debate.label',
    icon: RiChat3Line,
    description: 'shows.formatName.debate.description',
  },
  {
    id: 'interview',
    label: 'shows.formatName.interview.label',
    icon: RiQuestionLine,
    description: 'shows.formatName.interview.description',
  },
  {
    id: 'explainer',
    label: 'shows.formatName.explainer.label',
    icon: RiBookOpenLine,
    description: 'shows.formatName.explainer.description',
  },
];

/**
 * The audience, in the words a person would use.
 *
 * `private` is first and is the default, because a machine-generated podcast
 * about whatever its owner was reading is not something to publish by accident.
 */
const VISIBILITIES: Array<{
  id: ShowVisibility;
  label: string;
  icon: BloomIconComponent;
  description: string;
}> = [
  {
    id: 'private',
    label: 'shows.visibility.private.label',
    icon: RiLockLine,
    description: 'shows.visibility.private.description',
  },
  {
    id: 'unlisted',
    label: 'shows.visibility.unlisted.label',
    icon: RiLink,
    description: 'shows.visibility.unlisted.description',
  },
  {
    id: 'public',
    label: 'shows.visibility.public.label',
    icon: RiGlobalLine,
    description: 'shows.visibility.public.description',
  },
];

interface SeriesCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (seriesId: string) => void;
}

export function SeriesCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: SeriesCreateDialogProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const preferences = useShowStore((s) => s.preferences);
  const createSeries = useShowStore((s) => s.createSeries);

  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  // Seeded from the account's saved defaults, and `null` until the user picks —
  // so a preference arriving after mount is still respected without an effect
  // to copy it into state.
  const [format, setFormat] = useState<ShowFormat | null>(null);
  const [visibility, setVisibility] = useState<ShowVisibility | null>(null);
  const [creating, setCreating] = useState(false);

  const chosenFormat = format ?? preferences?.defaultFormat ?? 'podcast';
  const chosenVisibility =
    visibility ?? preferences?.defaultVisibility ?? 'private';

  const handleCreate = useCallback(async () => {
    if (title.trim().length < 3 || brief.trim().length < 10) {
      toast.error(t('shows.seriesDialog.incomplete'));
      return;
    }

    setCreating(true);
    try {
      const seriesId = await createSeries({
        title: title.trim(),
        brief: brief.trim(),
        format: chosenFormat,
        visibility: chosenVisibility,
      });

      if (seriesId) {
        toast.success(t('shows.seriesDialog.created'));
        onOpenChange(false);
        setTitle('');
        setBrief('');
        setFormat(null);
        setVisibility(null);
        onCreated?.(seriesId);
      }
    } finally {
      setCreating(false);
    }
  }, [
    title,
    brief,
    chosenFormat,
    chosenVisibility,
    createSeries,
    onOpenChange,
    onCreated,
    t,
  ]);

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      placement={{ base: 'bottom', md: 'center' }}
      title={t('shows.seriesDialog.title')}
      maxWidth={512}
      actions={[
        { label: t('common.cancel'), color: 'cancel', disabled: creating },
        {
          label: creating
            ? t('shows.seriesDialog.creating')
            : t('shows.seriesDialog.create'),
          onPress: handleCreate,
          disabled:
            creating || title.trim().length < 3 || brief.trim().length < 10,
          // Creation draws cover art and calls Syra, so the dialog owns the
          // progress label and stays mounted while it runs.
          shouldCloseOnPress: false,
        },
      ]}
    >
      {/* Stacking only: the form's fields, in a scroller capped at 384. */}
      <ScrollView className="max-h-96" showsVerticalScrollIndicator={false}>
        <View className="gap-4 py-2">
          <View>
            <TextFieldLabel>{t('shows.seriesDialog.name')}</TextFieldLabel>
            <TextFieldInput
              label={t('shows.seriesDialog.name')}
              value={title}
              onChangeText={setTitle}
              placeholder={t('shows.seriesDialog.namePlaceholder')}
            />
          </View>

          {/*
            The brief stays a form field rather than the chat composer: it is
            one of four inputs submitted together by the dialog's own "Create
            show" action, and the composer would add a second send button.
          */}
          <Textarea
            label={t('shows.seriesDialog.brief')}
            value={brief}
            onChangeText={setBrief}
            placeholder={t('shows.seriesDialog.briefPlaceholder')}
            rows={3}
            hint={t('shows.seriesDialog.briefHint')}
          />

          <View>
            <TextFieldLabel>{t('shows.seriesDialog.format')}</TextFieldLabel>
            <ChipRow
              role="radiogroup"
              accessibilityLabel={t('shows.seriesDialog.format')}
            >
              {FORMATS.map((option) => {
                const Icon = option.icon;
                const selected = chosenFormat === option.id;
                return (
                  <Chip
                    key={option.id}
                    size="xl"
                    role="radio"
                    selected={selected}
                    onPress={() => setFormat(option.id)}
                    startIcon={<Icon fill={colors.textSecondary} />}
                  >
                    {t(option.label)}
                  </Chip>
                );
              })}
            </ChipRow>
            <TextFieldHint>
              {t(FORMATS.find((f) => f.id === chosenFormat)?.description ?? '')}
            </TextFieldHint>
          </View>

          <View>
            <TextFieldLabel>{t('shows.seriesDialog.audience')}</TextFieldLabel>
            <SegmentedControl
              label={t('shows.seriesDialog.audience')}
              type="radio"
              value={chosenVisibility}
              onValueChange={(value) => setVisibility(value as ShowVisibility)}
            >
              {VISIBILITIES.map((option) => (
                <SegmentedControlItem key={option.id} value={option.id}>
                  <SegmentedControlItemText>
                    {t(option.label)}
                  </SegmentedControlItemText>
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            <TextFieldHint>
              {t(
                VISIBILITIES.find((v) => v.id === chosenVisibility)
                  ?.description ?? '',
              )}
            </TextFieldHint>
          </View>
        </View>
      </ScrollView>
    </Dialog>
  );
}

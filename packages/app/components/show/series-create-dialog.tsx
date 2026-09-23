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

import {
  useShowStore,
  type ShowFormat,
  type ShowVisibility,
} from '@/lib/stores/show-store';
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

const FORMATS: Array<{
  id: ShowFormat;
  label: string;
  icon: BloomIconComponent;
  description: string;
}> = [
  {
    id: 'podcast',
    label: 'Podcast',
    icon: RiMic2Line,
    description: 'Casual conversation between two hosts',
  },
  {
    id: 'news',
    label: 'News',
    icon: RiNewspaperLine,
    description: 'Professional news broadcast',
  },
  {
    id: 'debate',
    label: 'Debate',
    icon: RiChat3Line,
    description: 'Two sides, one moderator',
  },
  {
    id: 'interview',
    label: 'Interview',
    icon: RiQuestionLine,
    description: 'A host interviews a guest',
  },
  {
    id: 'explainer',
    label: 'Explainer',
    icon: RiBookOpenLine,
    description: 'A single narrator explains a topic',
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
    label: 'Private',
    icon: RiLockLine,
    description: 'Only you can listen',
  },
  {
    id: 'unlisted',
    label: 'Unlisted',
    icon: RiLink,
    description: 'Anyone with the link',
  },
  {
    id: 'public',
    label: 'Public',
    icon: RiGlobalLine,
    description: 'Listed on Syra for everyone',
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
      toast.error('A show needs a title and a sentence about what it covers');
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
        toast.success('Show created — add your first episode');
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
  ]);

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      placement={{ base: 'bottom', md: 'center' }}
      title="New show"
      maxWidth={512}
      actions={[
        { label: 'Cancel', color: 'cancel', disabled: creating },
        {
          label: creating ? 'Creating...' : 'Create show',
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
      <ScrollView style={{ maxHeight: 384 }} showsVerticalScrollIndicator={false}>
        <View style={{ gap: 16, paddingVertical: 8 }}>
          <View>
            <TextFieldLabel>Name</TextFieldLabel>
            <TextFieldInput
              label="Name"
              value={title}
              onChangeText={setTitle}
              placeholder="The Wednesday Digest"
            />
          </View>

          {/*
            The brief stays a form field rather than the chat composer: it is
            one of four inputs submitted together by the dialog's own "Create
            show" action, and the composer would add a second send button.
          */}
          <Textarea
            label="What is it about?"
            value={brief}
            onChangeText={setBrief}
            placeholder="A weekly look at what I have been reading, in plain language."
            rows={3}
            hint="This is the only thing an episode is written from, and — unless you say otherwise for one — the only thing its subject is chosen from. Describe the show and the ground it covers, not one episode: a line or two gives a show with nothing to vary along."
          />

          <View>
            <TextFieldLabel>Format</TextFieldLabel>
            <ChipRow role="radiogroup" accessibilityLabel="Format">
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
                    {option.label}
                  </Chip>
                );
              })}
            </ChipRow>
            <TextFieldHint>
              {FORMATS.find((f) => f.id === chosenFormat)?.description}
            </TextFieldHint>
          </View>

          <View>
            <TextFieldLabel>Who can listen?</TextFieldLabel>
            <SegmentedControl
              label="Who can listen?"
              type="radio"
              value={chosenVisibility}
              onValueChange={(value) => setVisibility(value as ShowVisibility)}
            >
              {VISIBILITIES.map((option) => (
                <SegmentedControlItem key={option.id} value={option.id}>
                  <SegmentedControlItemText>{option.label}</SegmentedControlItemText>
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            <TextFieldHint>
              {VISIBILITIES.find((v) => v.id === chosenVisibility)?.description}
            </TextFieldHint>
          </View>
        </View>
      </ScrollView>
    </Dialog>
  );
}

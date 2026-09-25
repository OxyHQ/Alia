/**
 * Steering ONE episode — the path for when you want a specific one.
 *
 * It is not how an episode is normally made. "New episode" on the show screen
 * is a single press with nothing to fill in, because the show already knows
 * what it is about: its brief and the subjects its earlier episodes used are
 * what decide the next one, server-side. This dialog exists for the other case
 * — there is something particular to cover this week, or an article to work
 * from — and every field in it is optional.
 *
 * The name is here too, and it works the same way: blank means the finished
 * script names the episode, which is something nobody can do in advance.
 * Typing one keeps it — an owner who has a name in mind should not lose it just
 * because the usual case is not to have one. Both fields are overrides, neither
 * is a rival default.
 */

import { useTranslation } from '@/shared/i18n/use-translation';
import { useShowStore } from '@/features/shows/runtime/show-store';
import { Dialog } from '@oxy.so/bloom/dialog';
import {
  TextFieldHint,
  TextFieldInput,
  TextFieldLabel,
} from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { Muted } from '@oxy.so/bloom/typography';
import { useCallback, useState } from 'react';
import { ScrollView, View } from 'react-native';

interface EpisodeCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seriesId: string;
  /** Shown as the heading, so the person does not have to count. */
  nextEpisodeNumber: number;
}

export function EpisodeCreateDialog({
  open,
  onOpenChange,
  seriesId,
  nextEpisodeNumber,
}: EpisodeCreateDialogProps) {
  const { t } = useTranslation();
  const createEpisode = useShowStore((s) => s.createEpisode);

  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [notes, setNotes] = useState('');
  const [starting, setStarting] = useState(false);

  const trimmedTitle = title.trim();
  const trimmedTopic = topic.trim();
  // Blank means "name it from the script". A couple of characters is a slip,
  // and discarding what somebody typed would be worse than saying so.
  const titleTooShort = trimmedTitle !== '' && trimmedTitle.length < 3;
  // Blank is fine and means "decide it yourself". A few characters is not a
  // subject, and silently discarding what somebody typed would be worse than
  // saying so.
  const topicTooShort = trimmedTopic !== '' && trimmedTopic.length < 5;

  const handleStart = useCallback(async () => {
    if (topicTooShort) {
      toast.error(t('shows.episodeDialog.topicTooShort'));
      return;
    }
    if (titleTooShort) {
      toast.error(t('shows.episodeDialog.titleTooShort'));
      return;
    }

    setStarting(true);
    try {
      const episodeId = await createEpisode(seriesId, {
        ...(trimmedTitle === '' ? {} : { title: trimmedTitle }),
        ...(trimmedTopic === '' ? {} : { topic: trimmedTopic }),
        ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
      });

      if (episodeId) {
        toast.success(t('shows.recordingStarted'));
        onOpenChange(false);
        setTitle('');
        setTopic('');
        setNotes('');
      }
    } finally {
      setStarting(false);
    }
  }, [
    trimmedTitle,
    titleTooShort,
    trimmedTopic,
    topicTooShort,
    notes,
    seriesId,
    createEpisode,
    onOpenChange,
    t,
  ]);

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      placement={{ base: 'bottom', md: 'center' }}
      title={t('shows.episodeNumber', { number: nextEpisodeNumber })}
      maxWidth={512}
      actions={[
        { label: t('common.cancel'), color: 'cancel', disabled: starting },
        {
          label: starting
            ? t('shows.starting')
            : t('shows.episodeDialog.record'),
          onPress: handleStart,
          disabled: starting || topicTooShort || titleTooShort,
          shouldCloseOnPress: false,
        },
      ]}
    >
      {/*
        Stacking only: the form's fields, in a scroller capped at 384. The topic
        and notes stay form fields rather than the chat composer — they are
        optional overrides submitted together by the dialog's "Record it"
        action, and the composer would add a second send button.
      */}
      <ScrollView className="max-h-96" showsVerticalScrollIndicator={false}>
        <View className="gap-4 py-2">
          <Textarea
            label={t('shows.episodeDialog.topicLabel')}
            value={topic}
            onChangeText={setTopic}
            placeholder={t('shows.episodeDialog.topicPlaceholder')}
            rows={3}
          />

          <Textarea
            label={t('shows.episodeDialog.notesLabel')}
            value={notes}
            onChangeText={setNotes}
            placeholder={t('shows.episodeDialog.notesPlaceholder')}
            rows={4}
          />

          <View>
            <TextFieldLabel>{t('shows.episodeDialog.nameLabel')}</TextFieldLabel>
            <TextFieldInput
              label={t('shows.episodeDialog.nameLabel')}
              value={title}
              onChangeText={setTitle}
              placeholder={t('shows.episodeDialog.namePlaceholder')}
            />
            <TextFieldHint>{t('shows.episodeDialog.nameHint')}</TextFieldHint>
          </View>

          <Muted>{t('shows.episodeDialog.noRepeat')}</Muted>
        </View>
      </ScrollView>
    </Dialog>
  );
}

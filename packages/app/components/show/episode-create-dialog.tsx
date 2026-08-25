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

import React, { useCallback, useState } from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { Dialog } from '@oxyhq/bloom/dialog';
import { toast } from '@oxyhq/bloom/toast';
import { useShowStore } from '@/lib/stores/show-store';

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
      toast.error('Say a bit more, or leave it blank and the show will choose');
      return;
    }
    if (titleTooShort) {
      toast.error('That name is too short — leave it blank to have one written');
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
        toast.success('Recording started');
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
  ]);

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      placement={{ base: 'bottom', md: 'center' }}
      title={`Episode ${nextEpisodeNumber}`}
      maxWidth={512}
      actions={[
        { label: 'Cancel', color: 'cancel', disabled: starting },
        {
          label: starting ? 'Starting...' : 'Record it',
          onPress: handleStart,
          disabled: starting || topicTooShort || titleTooShort,
          shouldCloseOnPress: false,
        },
      ]}
    >
      <ScrollView className="max-h-96" showsVerticalScrollIndicator={false}>
        <View className="gap-4 py-2">
          <View className="gap-1.5">
            <Text className="text-sm font-medium text-foreground">
              Anything specific this time?
            </Text>
            <Input
              value={topic}
              onChangeText={setTopic}
              placeholder="Leave blank and the show picks something it has not covered."
              multiline
              numberOfLines={3}
              className="min-h-[80px]"
            />
          </View>

          <View className="gap-1.5">
            <Text className="text-sm font-medium text-foreground">Source material (optional)</Text>
            <Input
              value={notes}
              onChangeText={setNotes}
              placeholder="Paste articles, notes or talking points to work from..."
              multiline
              numberOfLines={4}
              className="min-h-[100px]"
            />
          </View>

          <View className="gap-1.5">
            <Text className="text-sm font-medium text-foreground">Name (optional)</Text>
            <Input
              value={title}
              onChangeText={setTitle}
              placeholder="Leave blank and it is named once it is written"
            />
            <Text className="text-xs text-muted-foreground">
              This is the name listeners see. Left blank, the script names the episode after what
              it turned out to say.
            </Text>
          </View>

          <Text className="text-xs text-muted-foreground">
            Either way the script knows what every earlier episode covered, so it will not repeat
            one.
          </Text>
        </View>
      </ScrollView>
    </Dialog>
  );
}

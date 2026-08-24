/**
 * Adding an episode to an existing series.
 *
 * Deliberately short. The show's premise, its format and its cast were decided
 * when the series was created and apply to every episode, so this asks only
 * what changes: what this one is called and what it covers.
 *
 * The name is OPTIONAL and usually left blank. Syra fixes an episode's title
 * when the draft is reserved and refuses to let the ingest change it, so the
 * script can never name its own episode — a model names it from the topic
 * instead, server-side, before the draft. Typing one here overrides that.
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
  /** Shown as the suggested name, so the person does not have to count. */
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

  const handleStart = useCallback(async () => {
    if (topic.trim().length < 5) {
      toast.error('Say what the episode should cover');
      return;
    }
    // A name that is present but too short is a mistake, not a request to name
    // it automatically — refuse it rather than silently discarding what they
    // typed.
    if (title.trim() !== '' && title.trim().length < 3) {
      toast.error('That name is too short — leave it blank to have one written');
      return;
    }

    setStarting(true);
    try {
      const episodeId = await createEpisode(seriesId, {
        ...(title.trim() === '' ? {} : { title: title.trim() }),
        topic: topic.trim(),
        notes: notes.trim() || undefined,
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
  }, [title, topic, notes, seriesId, createEpisode, onOpenChange]);

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
          disabled: starting || topic.trim().length < 5,
          shouldCloseOnPress: false,
        },
      ]}
    >
      <ScrollView className="max-h-96" showsVerticalScrollIndicator={false}>
        <View className="gap-4 py-2">
          <View className="gap-1.5">
            <Text className="text-sm font-medium text-foreground">What should it cover?</Text>
            <Input
              value={topic}
              onChangeText={setTopic}
              placeholder="What happened this week, and why it matters."
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
              placeholder="Leave blank and one will be written for you"
            />
            <Text className="text-xs text-muted-foreground">
              This is the name listeners see, and it cannot be changed once the episode is
              published.
            </Text>
          </View>

          <Text className="text-xs text-muted-foreground">
            The script knows what your last few episodes covered, so it will not repeat them.
          </Text>
        </View>
      </ScrollView>
    </Dialog>
  );
}

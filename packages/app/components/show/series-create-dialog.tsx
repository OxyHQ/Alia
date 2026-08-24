/**
 * Creating a show SERIES — the thing episodes belong to.
 *
 * A series is a real podcast on Syra: it gets cover art, a visibility, and a
 * feed. So this asks for what a podcast needs rather than for one episode's
 * topic — a title, what the show is about, and who may hear it — and the
 * episode dialog asks for the rest, once per episode.
 */

import React, { useCallback, useState } from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog } from '@oxyhq/bloom/dialog';
import { toast } from '@oxyhq/bloom/toast';
import { Mic, Newspaper, MessageSquare, HelpCircle, BookOpen, Lock, Link2, Globe } from 'lucide-react-native';
import { useShowStore, type ShowFormat, type ShowVisibility } from '@/lib/stores/show-store';
import { cn } from '@/lib/utils';

const FORMATS: Array<{ id: ShowFormat; label: string; icon: typeof Mic; description: string }> = [
  { id: 'podcast', label: 'Podcast', icon: Mic, description: 'Casual conversation between two hosts' },
  { id: 'news', label: 'News', icon: Newspaper, description: 'Professional news broadcast' },
  { id: 'debate', label: 'Debate', icon: MessageSquare, description: 'Two sides, one moderator' },
  { id: 'interview', label: 'Interview', icon: HelpCircle, description: 'A host interviews a guest' },
  { id: 'explainer', label: 'Explainer', icon: BookOpen, description: 'A single narrator explains a topic' },
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
  icon: typeof Lock;
  description: string;
}> = [
  { id: 'private', label: 'Private', icon: Lock, description: 'Only you can listen' },
  { id: 'unlisted', label: 'Unlisted', icon: Link2, description: 'Anyone with the link' },
  { id: 'public', label: 'Public', icon: Globe, description: 'Listed on Syra for everyone' },
];

interface SeriesCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (seriesId: string) => void;
}

export function SeriesCreateDialog({ open, onOpenChange, onCreated }: SeriesCreateDialogProps) {
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
  const chosenVisibility = visibility ?? preferences?.defaultVisibility ?? 'private';

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
  }, [title, brief, chosenFormat, chosenVisibility, createSeries, onOpenChange, onCreated]);

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
          disabled: creating || title.trim().length < 3 || brief.trim().length < 10,
          // Creation draws cover art and calls Syra, so the dialog owns the
          // progress label and stays mounted while it runs.
          shouldCloseOnPress: false,
        },
      ]}
    >
      <ScrollView className="max-h-96" showsVerticalScrollIndicator={false}>
        <View className="gap-4 py-2">
          <View className="gap-1.5">
            <Text className="text-sm font-medium text-foreground">Name</Text>
            <Input value={title} onChangeText={setTitle} placeholder="The Wednesday Digest" />
          </View>

          <View className="gap-1.5">
            <Text className="text-sm font-medium text-foreground">What is it about?</Text>
            <Input
              value={brief}
              onChangeText={setBrief}
              placeholder="A weekly look at what I have been reading, in plain language."
              multiline
              numberOfLines={3}
              className="min-h-[80px]"
            />
            <Text className="text-xs text-muted-foreground">
              Every episode is written from this, so describe the show rather than one episode.
            </Text>
          </View>

          <View className="gap-1.5">
            <Text className="text-sm font-medium text-foreground">Format</Text>
            <View className="flex-row flex-wrap gap-2">
              {FORMATS.map((option) => {
                const Icon = option.icon;
                const selected = chosenFormat === option.id;
                return (
                  <Button
                    key={option.id}
                    variant={selected ? 'default' : 'outline'}
                    size="sm"
                    className={cn('flex-row items-center gap-1.5', selected && 'border-primary')}
                    onPress={() => setFormat(option.id)}
                  >
                    <Icon
                      size={14}
                      className={selected ? 'text-primary-foreground' : 'text-muted-foreground'}
                    />
                    <Text
                      className={cn(
                        'text-xs',
                        selected ? 'text-primary-foreground' : 'text-foreground',
                      )}
                    >
                      {option.label}
                    </Text>
                  </Button>
                );
              })}
            </View>
            <Text className="text-xs text-muted-foreground">
              {FORMATS.find((f) => f.id === chosenFormat)?.description}
            </Text>
          </View>

          <View className="gap-1.5">
            <Text className="text-sm font-medium text-foreground">Who can listen?</Text>
            <View className="flex-row flex-wrap gap-2">
              {VISIBILITIES.map((option) => {
                const Icon = option.icon;
                const selected = chosenVisibility === option.id;
                return (
                  <Button
                    key={option.id}
                    variant={selected ? 'default' : 'outline'}
                    size="sm"
                    className={cn('flex-row items-center gap-1.5', selected && 'border-primary')}
                    onPress={() => setVisibility(option.id)}
                  >
                    <Icon
                      size={14}
                      className={selected ? 'text-primary-foreground' : 'text-muted-foreground'}
                    />
                    <Text
                      className={cn(
                        'text-xs',
                        selected ? 'text-primary-foreground' : 'text-foreground',
                      )}
                    >
                      {option.label}
                    </Text>
                  </Button>
                );
              })}
            </View>
            <Text className="text-xs text-muted-foreground">
              {VISIBILITIES.find((v) => v.id === chosenVisibility)?.description}
            </Text>
          </View>
        </View>
      </ScrollView>
    </Dialog>
  );
}

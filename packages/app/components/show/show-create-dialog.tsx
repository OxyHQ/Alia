import React, { useState, useCallback } from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useShowStore, type ShowFormat } from '@/lib/stores/show-store';
import { toast } from '@/components/sonner';
import { Mic, Newspaper, MessageSquare, HelpCircle, BookOpen } from 'lucide-react-native';
import { cn } from '@/lib/utils';

const FORMATS: Array<{ id: ShowFormat; label: string; icon: typeof Mic; description: string }> = [
  { id: 'podcast', label: 'Podcast', icon: Mic, description: 'Casual conversation between hosts' },
  { id: 'news', label: 'News', icon: Newspaper, description: 'Professional news broadcast' },
  { id: 'debate', label: 'Debate', icon: MessageSquare, description: 'Two sides, one moderator' },
  { id: 'interview', label: 'Interview', icon: HelpCircle, description: 'Host interviews a guest' },
  { id: 'explainer', label: 'Explainer', icon: BookOpen, description: 'Single narrator explains a topic' },
];

interface ShowCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShowCreateDialog({ open, onOpenChange }: ShowCreateDialogProps) {
  const [topic, setTopic] = useState('');
  const [format, setFormat] = useState<ShowFormat>('podcast');
  const [notes, setNotes] = useState('');
  const [generating, setGenerating] = useState(false);
  const generateShow = useShowStore(s => s.generateShow);

  const handleGenerate = useCallback(async () => {
    if (!topic.trim() || topic.trim().length < 5) {
      toast.error('Topic must be at least 5 characters');
      return;
    }

    setGenerating(true);
    try {
      const showId = await generateShow({
        topic: topic.trim(),
        format,
        sourceNotes: notes.trim() || undefined,
      });

      if (showId) {
        toast.success('Show generation started!');
        onOpenChange(false);
        setTopic('');
        setNotes('');
        setFormat('podcast');
      }
    } finally {
      setGenerating(false);
    }
  }, [topic, format, notes, generateShow, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Show</DialogTitle>
        </DialogHeader>
        <ScrollView className="max-h-96" showsVerticalScrollIndicator={false}>
          <View className="gap-4 py-2">
            <View className="gap-1.5">
              <Text className="text-sm font-medium text-foreground">Topic</Text>
              <Input
                value={topic}
                onChangeText={setTopic}
                placeholder="What should the show be about?"
                multiline
                numberOfLines={3}
                className="min-h-[80px]"
              />
            </View>

            <View className="gap-1.5">
              <Text className="text-sm font-medium text-foreground">Format</Text>
              <View className="flex-row flex-wrap gap-2">
                {FORMATS.map(f => {
                  const Icon = f.icon;
                  const isSelected = format === f.id;
                  return (
                    <Button
                      key={f.id}
                      variant={isSelected ? 'default' : 'outline'}
                      size="sm"
                      className={cn('flex-row gap-1.5 items-center', isSelected && 'border-primary')}
                      onPress={() => setFormat(f.id)}
                    >
                      <Icon size={14} className={isSelected ? 'text-primary-foreground' : 'text-muted-foreground'} />
                      <Text className={cn('text-xs', isSelected ? 'text-primary-foreground' : 'text-foreground')}>
                        {f.label}
                      </Text>
                    </Button>
                  );
                })}
              </View>
              <Text className="text-xs text-muted-foreground">
                {FORMATS.find(f => f.id === format)?.description}
              </Text>
            </View>

            <View className="gap-1.5">
              <Text className="text-sm font-medium text-foreground">Notes (optional)</Text>
              <Input
                value={notes}
                onChangeText={setNotes}
                placeholder="Add context, talking points, or source material..."
                multiline
                numberOfLines={4}
                className="min-h-[100px]"
              />
            </View>
          </View>
        </ScrollView>
        <DialogFooter>
          <Button variant="outline" onPress={() => onOpenChange(false)} disabled={generating}>
            <Text>Cancel</Text>
          </Button>
          <Button onPress={handleGenerate} disabled={generating || topic.trim().length < 5}>
            <Text className="text-primary-foreground">{generating ? 'Creating...' : 'Generate'}</Text>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

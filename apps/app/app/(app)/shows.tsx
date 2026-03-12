import React, { useEffect, useState, useCallback } from 'react';
import { View, Pressable, RefreshControl, useWindowDimensions, FlatList } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Plus, Mic, Trash2, AlertCircle, CheckCircle } from 'lucide-react-native';
import { useShowStore, type Show } from '@/lib/stores/show-store';
import { ShowPlayer } from '@/components/show/show-player';
import { ShowProgressCard } from '@/components/show/show-progress';
import { ShowCreateDialog } from '@/components/show/show-create-dialog';
import { useColorScheme } from '@/lib/useColorScheme';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/sonner';
import { cn } from '@/lib/utils';
import { useShowProgress } from '@/lib/hooks/use-show-progress';

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  queued: { label: 'Queued', color: 'text-muted-foreground' },
  generating_script: { label: 'Writing Script', color: 'text-blue-500' },
  generating_audio: { label: 'Generating Audio', color: 'text-blue-500' },
  concatenating: { label: 'Assembling', color: 'text-blue-500' },
  completed: { label: 'Ready', color: 'text-green-500' },
  failed: { label: 'Failed', color: 'text-red-500' },
};

const formatDate = (dateStr: string) => {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

function ShowCard({ show, onDelete }: {
  show: Show;
  onDelete: (id: string) => void;
}) {
  const progress = useShowStore(s => s.activeGenerations.get(show._id));
  const isActive = ['queued', 'generating_script', 'generating_audio', 'concatenating'].includes(show.status);
  const statusConfig = STATUS_CONFIG[show.status] || STATUS_CONFIG.queued;

  return (
    <View className="bg-card rounded-xl border border-border p-4 gap-3">
      {/* Header */}
      <View className="flex-row items-start justify-between">
        <View className="flex-1 gap-1">
          <Text className="text-base font-semibold text-foreground" numberOfLines={2}>
            {show.title}
          </Text>
          {show.description && (
            <Text className="text-xs text-muted-foreground" numberOfLines={2}>
              {show.description}
            </Text>
          )}
        </View>
        <View className="flex-row items-center gap-1.5 ml-2">
          {show.status === 'completed' && <CheckCircle size={14} className="text-green-500" />}
          {show.status === 'failed' && <AlertCircle size={14} className="text-red-500" />}
          <Text className={cn('text-xs font-medium', statusConfig.color)}>
            {statusConfig.label}
          </Text>
        </View>
      </View>

      {/* Format + Date */}
      <View className="flex-row items-center gap-2">
        <View className="px-2 py-0.5 bg-muted rounded-full">
          <Text className="text-[10px] uppercase font-medium text-muted-foreground">
            {show.format}
          </Text>
        </View>
        <Text className="text-xs text-muted-foreground">{formatDate(show.createdAt)}</Text>
        {show.speakers?.length > 0 && (
          <Text className="text-xs text-muted-foreground">
            {show.speakers.map(s => s.name).join(', ')}
          </Text>
        )}
      </View>

      {/* Progress or Player */}
      {isActive && progress && (
        <ShowProgressCard progress={progress} />
      )}

      {show.status === 'completed' && show.audioUrl && (
        <ShowPlayer
          audioUrl={show.audioUrl}
          title={show.title}
          durationMs={show.durationMs}
        />
      )}

      {show.status === 'failed' && show.error && (
        <View className="p-2 bg-destructive/10 rounded-lg">
          <Text className="text-xs text-destructive">{show.error}</Text>
        </View>
      )}

      {/* Actions */}
      <View className="flex-row justify-end">
        <Pressable
          onPress={() => onDelete(show._id)}
          className="p-2 active:opacity-70"
        >
          <Trash2 size={14} className="text-muted-foreground" />
        </Pressable>
      </View>
    </View>
  );
}

export default function ShowsScreen() {
  const shows = useShowStore(s => s.shows);
  const loading = useShowStore(s => s.loading);
  const error = useShowStore(s => s.error);
  const fetchShows = useShowStore(s => s.fetchShows);
  const deleteShow = useShowStore(s => s.deleteShow);
  const { colors } = useColorScheme();
  const { width } = useWindowDimensions();

  // Listen for real-time progress updates
  useShowProgress();

  const [createOpen, setCreateOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetchShows();
  }, [fetchShows]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchShows();
    setRefreshing(false);
  }, [fetchShows]);

  const handleDelete = useCallback((id: string) => {
    deleteShow(id);
    toast.success('Show deleted');
  }, [deleteShow]);

  const renderItem = useCallback(({ item }: { item: Show }) => (
    <View className="px-4 pb-3">
      <ShowCard show={item} onDelete={handleDelete} />
    </View>
  ), [handleDelete]);

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 pt-4 pb-2">
        <View className="flex-row items-center gap-2">
          <Mic size={20} className="text-foreground" />
          <Text className="text-xl font-bold text-foreground">Shows</Text>
        </View>
        <Button
          size="sm"
          className="flex-row items-center gap-1.5"
          onPress={() => setCreateOpen(true)}
        >
          <Plus size={14} className="text-primary-foreground" />
          <Text className="text-primary-foreground text-sm">New</Text>
        </Button>
      </View>

      {error && (
        <View className="px-4 pb-2">
          <View className="p-2 bg-destructive/10 rounded-lg">
            <Text className="text-xs text-destructive">{error}</Text>
          </View>
        </View>
      )}

      {loading && shows.length === 0 ? (
        <View className="gap-3 px-4 pt-2">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-32 w-full rounded-xl" />
          ))}
        </View>
      ) : shows.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-4 px-8">
          <Mic size={48} className="text-muted-foreground" />
          <Text className="text-lg font-semibold text-foreground text-center">
            No shows yet
          </Text>
          <Text className="text-sm text-muted-foreground text-center">
            Create your first AI-generated show with multiple speakers, sound effects, and more.
          </Text>
          <Button onPress={() => setCreateOpen(true)} className="flex-row items-center gap-1.5">
            <Plus size={14} className="text-primary-foreground" />
            <Text className="text-primary-foreground">Create Show</Text>
          </Button>
        </View>
      ) : (
        <FlatList
          data={shows}
          renderItem={renderItem}
          keyExtractor={item => item._id}
          contentContainerStyle={{ paddingTop: 8, paddingBottom: 20 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
        />
      )}

      <ShowCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </View>
  );
}

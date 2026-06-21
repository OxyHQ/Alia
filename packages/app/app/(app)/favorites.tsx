import React, { useState, useMemo, useCallback } from 'react';
import { View, ScrollView, Pressable, TextInput, RefreshControl } from 'react-native';
import { Text } from '@/components/ui/text';
import { Search, Star, X } from 'lucide-react-native';
import { useFavoritesStore } from '@/lib/stores/favorites-store';
import { useConversations } from '@/lib/hooks/use-conversations';
import { useRouter } from 'expo-router';
import { useColorScheme } from '@/lib/useColorScheme';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

export default function FavoritesScreen() {
  const { colors } = useColorScheme();
  const router = useRouter();
  const favoriteIds = useFavoritesStore((state) => state.favoriteConversationIds);
  const toggleFavorite = useFavoritesStore((state) => state.toggleFavorite);
  const { data, isLoading, refetch } = useConversations();
  const [searchQuery, setSearchQuery] = useState('');

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const allConversations = useMemo(() => {
    return data?.pages.flatMap(page => page.conversations) || [];
  }, [data]);

  const favoriteConversations = useMemo(() => {
    let filtered = allConversations.filter((conv) => favoriteIds.includes(conv.id));
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((conv) =>
        (conv.title || '').toLowerCase().includes(query)
      );
    }
    return filtered.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }, [allConversations, favoriteIds, searchQuery]);

  const handleSelect = (id: string) => {
    router.replace(`/(app)/c/${id}`);
  };

  const handleUnfavorite = async (id: string) => {
    await toggleFavorite(id);
  };

  const formatDate = (date: Date) => {
    const d = new Date(date);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Header */}
        <View className="px-5 pt-6 pb-1">
          <Text className="text-2xl font-bold text-foreground">
            Favorites
          </Text>
          <Text className="text-[13px] text-muted-foreground mt-0.5">
            Your saved conversations
          </Text>
        </View>

        {/* Search */}
        <View className="px-5 pt-3 pb-2">
          <View className="flex-row items-center gap-2 bg-muted/70 rounded-lg px-3 py-2">
            <Search size={15} className="text-muted-foreground" />
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search favorites..."
              placeholderTextColor={colors.mutedForeground}
              className="flex-1 text-[13px] text-foreground"
            />
          </View>
        </View>

        {/* Count */}
        <View className="px-5 py-2">
          <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
            {favoriteConversations.length} {favoriteConversations.length === 1 ? 'favorite' : 'favorites'}
          </Text>
        </View>

        {/* List */}
        <View className="px-5 pb-6">
          {isLoading && allConversations.length === 0 ? (
            <View className="gap-0.5">
              {Array.from({ length: 4 }).map((_, i) => (
                <View key={i} className="flex-row items-center py-2.5 gap-3">
                  <View className="flex-1 gap-1.5">
                    <Skeleton style={{ width: '55%', height: 14, borderRadius: 8 }} />
                    <Skeleton style={{ width: '30%', height: 10, borderRadius: 6 }} />
                  </View>
                  <Skeleton style={{ width: 28, height: 28, borderRadius: 14 }} />
                </View>
              ))}
            </View>
          ) : (
            <>
          {favoriteConversations.map((conv) => (
            <Pressable
              key={conv.id}
              onPress={() => handleSelect(conv.id)}
              className="active:opacity-70"
            >
              <View className="flex-row items-center py-2.5 gap-3">
                <View className="flex-1">
                  <Text className="text-[14px] font-semibold text-foreground" numberOfLines={1}>
                    {conv.title || 'New conversation'}
                  </Text>
                  <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                    {formatDate(conv.updatedAt)}
                  </Text>
                </View>
                <Pressable
                  onPress={() => handleUnfavorite(conv.id)}
                  className="h-8 w-8 items-center justify-center rounded-full active:bg-muted/70"
                >
                  <Star size={14} className="text-amber-500" fill="#f59e0b" />
                </Pressable>
              </View>
            </Pressable>
          ))}

          {favoriteConversations.length === 0 && (
            <View className="items-center justify-center py-16">
              <Star size={32} className="text-muted-foreground/30 mb-3" />
              <Text className="text-sm font-medium text-foreground">
                No favorites yet
              </Text>
              <Text className="text-xs text-muted-foreground text-center mt-1">
                {searchQuery ? 'Try a different search' : 'Star conversations to save them here'}
              </Text>
            </View>
          )}
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { View, ScrollView, Pressable, TextInput, RefreshControl } from 'react-native';
import { KeyboardAwareScrollView } from '@/lib/keyboard';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import {
  Plus,
  Star,
  CheckCircle2,
  Search,
  ArrowRight,
  TrendingUp
} from 'lucide-react-native';
import { useRolesStore } from '@/lib/stores/roles-store';
import { useRouter } from 'expo-router';
import { useTranslation } from '@/hooks/useTranslation';
import { toast } from '@/components/sonner';
import { cn } from '@/lib/utils';
import { useColorScheme } from '@/lib/useColorScheme';
import { Skeleton } from '@/components/ui/skeleton';

export default function RolesScreen() {
  const { t } = useTranslation();
  const roles = useRolesStore((state) => state.roles);
  const loadRoles = useRolesStore((state) => state.loadRoles);
  const isInitialLoad = roles.length === 0;
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const router = useRouter();
  const { colors } = useColorScheme();

  useEffect(() => {
    loadRoles();
  }, [loadRoles]);

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadRoles();
    setRefreshing(false);
  }, [loadRoles]);

  const handleSelectRole = (roleId: string) => {
    router.push(`/(app)/roles/${roleId}`);
  };

  const handleCreateRole = () => {
    toast.info(t('roles.createComingSoon'));
  };

  const categories = useMemo(() => {
    const cats = new Set(roles.map(r => r.category));
    return [t('common.all'), ...Array.from(cats)];
  }, [roles, t]);

  const filteredRoles = useMemo(() => {
    let filtered = roles;
    if (selectedCategory && selectedCategory !== t('common.all')) {
      filtered = filtered.filter(role => role.category === selectedCategory);
    }
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(role =>
        role.name.toLowerCase().includes(query) ||
        role.tagline?.toLowerCase().includes(query) ||
        role.description.toLowerCase().includes(query) ||
        role.category.toLowerCase().includes(query)
      );
    }
    return filtered;
  }, [roles, searchQuery, selectedCategory]);

  const featuredRoles = useMemo(() => roles.filter(r => r.isFeatured), [roles]);

  return (
    <View className="flex-1 bg-background">
      <KeyboardAwareScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Header */}
        <View className="px-5 pt-6 pb-1">
          <View className="flex-row items-center justify-between">
            <Text className="text-2xl font-bold text-foreground">
              {t('roles.title')}
            </Text>
            <Button
              onPress={handleCreateRole}
              size="icon"
              className="rounded-full h-8 w-8"
            >
              <Plus size={16} className="text-primary-foreground" />
            </Button>
          </View>
          <Text className="text-[13px] text-muted-foreground mt-0.5">
            {t('roles.subtitle')}
          </Text>
        </View>

        {/* Search */}
        <View className="px-5 pt-3 pb-2">
          <View className="flex-row items-center gap-2 bg-muted/70 rounded-lg px-3 py-2">
            <Search size={15} className="text-muted-foreground" />
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={t('roles.searchPlaceholder')}
              placeholderTextColor={colors.mutedForeground}
              className="flex-1 text-[13px] text-foreground"
            />
          </View>
        </View>

        {/* Category Chips */}
        <View className="py-2">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20 }}>
            <View className="flex-row gap-1.5">
              {categories.map((category) => {
                const isActive = selectedCategory === category || (!selectedCategory && category === t('common.all'));
                return (
                  <Pressable
                    key={category}
                    onPress={() => setSelectedCategory(category === t('common.all') ? null : category)}
                    className="active:opacity-70"
                  >
                    <View className={cn(
                      "px-3 py-1 rounded-full",
                      isActive ? "bg-foreground" : "bg-muted/70"
                    )}>
                      <Text className={cn(
                        "text-xs font-medium",
                        isActive ? "text-background" : "text-muted-foreground"
                      )}>
                        {category}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </View>

        {/* Featured Section */}
        {!searchQuery && !selectedCategory && featuredRoles.length > 0 && (
          <View className="mt-2 mb-4">
            <View className="px-5 mb-2">
              <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
                {t('roles.featured')}
              </Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20 }}>
              {featuredRoles.map((role) => (
                <FeaturedRoleCard key={role.id} role={role} onPress={handleSelectRole} />
              ))}
            </ScrollView>
          </View>
        )}

        {/* All Roles List */}
        <View className="px-5 pb-6">
          {(searchQuery || selectedCategory) && (
            <View className="mb-2">
              <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
                {filteredRoles.length} {filteredRoles.length === 1 ? 'role' : 'roles'}
              </Text>
            </View>
          )}
          {!searchQuery && !selectedCategory && (
            <View className="mb-2">
              <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
                {t('common.all')}
              </Text>
            </View>
          )}
          {isInitialLoad ? (
            <View className="gap-0.5">
              {Array.from({ length: 5 }).map((_, i) => (
                <View key={i} className="flex-row items-center py-2.5 gap-3">
                  <Skeleton style={{ width: 36, height: 36, borderRadius: 18 }} />
                  <View className="flex-1 gap-1.5">
                    <Skeleton style={{ width: '50%', height: 14, borderRadius: 8 }} />
                    <Skeleton style={{ width: '70%', height: 10, borderRadius: 6 }} />
                  </View>
                  <Skeleton style={{ width: 30, height: 12, borderRadius: 6 }} />
                </View>
              ))}
            </View>
          ) : (
            <View>
              {filteredRoles.map((role) => (
                <RoleListItem key={role.id} role={role} onPress={handleSelectRole} />
              ))}
            </View>
          )}

          {filteredRoles.length === 0 && !isInitialLoad && (
            <View className="items-center justify-center py-16">
              <Text className="text-sm font-medium text-foreground">
                {t('roles.noRoles')}
              </Text>
              <Text className="text-xs text-muted-foreground text-center mt-1">
                {searchQuery ? t('common.tryDifferentSearch') : t('roles.createToStart')}
              </Text>
            </View>
          )}
        </View>
      </KeyboardAwareScrollView>
    </View>
  );
}

function FeaturedRoleCard({
  role,
  onPress,
}: {
  role: any;
  onPress: (id: string) => void;
}) {
  return (
    <Pressable
      onPress={() => onPress(role.id)}
      className="active:opacity-80 mr-2.5"
      style={{ width: 220 }}
    >
      <View className="bg-muted/50 rounded-xl p-4">
        <View className="flex-row items-center gap-1.5 mb-2">
          {role.isVerified && (
            <CheckCircle2 size={12} className="text-blue-500" fill="#3b82f6" strokeWidth={0} />
          )}
          <Text className="text-[11px] font-medium text-muted-foreground">{role.category}</Text>
        </View>
        <Text className="text-[15px] font-bold text-foreground mb-0.5" numberOfLines={1}>
          {role.name}
        </Text>
        <Text className="text-xs text-muted-foreground mb-3 leading-4" numberOfLines={2}>
          {role.tagline}
        </Text>
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2.5">
            <View className="flex-row items-center gap-0.5">
              <Star size={11} className="text-amber-500" fill="#f59e0b" />
              <Text className="text-[11px] font-semibold text-foreground">{role.rating}</Text>
            </View>
            <Text className="text-[11px] text-muted-foreground">
              {role.usageCount > 1000 ? `${(role.usageCount / 1000).toFixed(1)}k` : role.usageCount} uses
            </Text>
          </View>
          <ArrowRight size={14} className="text-muted-foreground" />
        </View>
      </View>
    </Pressable>
  );
}

function RoleListItem({
  role,
  onPress,
}: {
  role: any;
  onPress: (id: string) => void;
}) {
  return (
    <Pressable
      onPress={() => onPress(role.id)}
      className="active:opacity-70"
    >
      <View className="flex-row items-center py-2.5 gap-3">
        {/* Avatar */}
        <View className="w-9 h-9 rounded-full bg-muted items-center justify-center">
          <Text className="text-xs font-bold text-foreground">
            {role.name.charAt(0)}
          </Text>
        </View>

        {/* Content */}
        <View className="flex-1">
          <View className="flex-row items-center gap-1">
            <Text className="text-[14px] font-semibold text-foreground" numberOfLines={1}>
              {role.name}
            </Text>
            {role.isVerified && (
              <CheckCircle2 size={12} className="text-blue-500" fill="#3b82f6" strokeWidth={0} />
            )}
          </View>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {role.tagline}
          </Text>
        </View>

        {/* Right side */}
        <View className="flex-row items-center gap-1">
          <Star size={10} className="text-amber-500" fill="#f59e0b" />
          <Text className="text-[11px] font-medium text-foreground">{role.rating}</Text>
        </View>
      </View>
    </Pressable>
  );
}

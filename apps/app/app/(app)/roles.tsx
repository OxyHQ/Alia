import React, { useEffect, useState, useMemo } from 'react';
import { View, ScrollView, Pressable, TextInput } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  BrainCircuit,
  Plus,
  Star,
  Users,
  CheckCircle2,
  Sparkles,
  Flame,
  Search
} from 'lucide-react-native';
import { useRolesStore } from '@/lib/stores/roles-store';
import { useRouter } from 'expo-router';
import { cn } from '@/lib/utils';
import { useColorScheme } from '@/lib/useColorScheme';

export default function RolesScreen() {
  const roles = useRolesStore((state) => state.roles);
  const loadRoles = useRolesStore((state) => state.loadRoles);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const router = useRouter();
  const { colors } = useColorScheme();

  useEffect(() => {
    loadRoles();
  }, [loadRoles]);

  const handleSelectRole = (roleId: string) => {
    router.push(`/(app)/roles/${roleId}`);
  };

  const handleCreateRole = () => {
    console.log('Create new role');
  };

  // Get unique categories
  const categories = useMemo(() => {
    const cats = new Set(roles.map(r => r.category));
    return ['All', ...Array.from(cats)];
  }, [roles]);

  // Filter roles based on search query and category
  const filteredRoles = useMemo(() => {
    let filtered = roles;

    // Filter by category
    if (selectedCategory && selectedCategory !== 'All') {
      filtered = filtered.filter(role => role.category === selectedCategory);
    }

    // Filter by search query
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

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1">
        {/* Hero Section - Centered */}
        <View className="items-center px-6 py-12">
          <BrainCircuit size={48} className="text-primary mb-4" />
          <Text className="text-4xl font-bold text-foreground mb-3 text-center">
            Roles
          </Text>
          <Text className="text-base text-muted-foreground mb-6 text-center max-w-md">
            An app store for ways of thinking. Discover, customize, and share AI personalities.
          </Text>

          {/* Search Bar */}
          <View className="w-full max-w-md flex-row items-center gap-2 bg-muted rounded-full px-4 py-3 mb-4">
            <Search size={18} className="text-muted-foreground" />
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search roles..."
              placeholderTextColor={colors.mutedForeground}
              className="flex-1 text-sm text-foreground"
            />
          </View>

          {/* Create Button */}
          <Button
            onPress={handleCreateRole}
            className="h-11 px-6 rounded-full"
          >
            <View className="flex-row items-center gap-2">
              <Plus size={18} className="text-primary-foreground" />
              <Text className="text-sm font-semibold text-primary-foreground">
                Create Role
              </Text>
            </View>
          </Button>
        </View>

        {/* Category Chips */}
        <View className="px-6 pb-4">
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="flex-row gap-2">
              {categories.map((category) => (
                <Pressable
                  key={category}
                  onPress={() => setSelectedCategory(category === 'All' ? null : category)}
                  className="active:opacity-70"
                >
                  <View className={cn(
                    "px-4 py-2 rounded-full border",
                    (selectedCategory === category || (!selectedCategory && category === 'All'))
                      ? "bg-primary border-primary"
                      : "bg-background border-border"
                  )}>
                    <Text className={cn(
                      "text-sm font-medium",
                      (selectedCategory === category || (!selectedCategory && category === 'All'))
                        ? "text-primary-foreground"
                        : "text-foreground"
                    )}>
                      {category}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        </View>

        {/* Roles Grid */}
        <View className="px-6 pb-6">
          <View className="flex-row flex-wrap gap-3">
            {filteredRoles.map((role) => (
              <RoleCard
                key={role.id}
                role={role}
                onPress={handleSelectRole}
              />
            ))}
          </View>

          {filteredRoles.length === 0 && (
            <View className="items-center justify-center py-20">
              <BrainCircuit size={64} className="text-muted-foreground opacity-50" />
              <Text className="text-lg font-medium text-foreground mt-4">
                No roles found
              </Text>
              <Text className="text-sm text-muted-foreground text-center mt-2 max-w-md">
                {searchQuery ? 'Try a different search term' : 'Create your own custom role to get started'}
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function RoleCard({
  role,
  onPress,
}: {
  role: any;
  onPress: (id: string) => void;
}) {
  return (
    <Pressable
      onPress={() => onPress(role.id)}
      className="active:opacity-70 w-[48%] md:w-[31%]"
    >
      <Card className="overflow-hidden h-full">
        <View className="p-4">
          {/* Badges */}
          <View className="flex-row items-center gap-1 mb-3 flex-wrap">
            {role.isFeatured && (
              <View className="bg-amber-500/20 px-1.5 py-0.5 rounded-full">
                <Sparkles size={8} className="text-amber-600" />
              </View>
            )}
            {role.isTrending && (
              <View className="bg-orange-500/20 px-1.5 py-0.5 rounded-full">
                <Flame size={8} className="text-orange-600" />
              </View>
            )}
            {role.isVerified && (
              <View className="bg-blue-500/20 px-1.5 py-0.5 rounded-full">
                <CheckCircle2 size={8} className="text-blue-600" />
              </View>
            )}
          </View>

          {/* Role Name */}
          <Text className="text-base font-semibold text-foreground mb-1" numberOfLines={1}>
            {role.name}
          </Text>

          {/* Tagline */}
          {role.tagline && (
            <Text className="text-xs text-muted-foreground mb-3" numberOfLines={2}>
              {role.tagline}
            </Text>
          )}

          {/* Author Info */}
          <View className="flex-row items-center gap-2 mb-3">
            <View className="w-6 h-6 rounded-full bg-primary/20 items-center justify-center">
              <Text className="text-xs font-semibold text-primary">
                {role.author.charAt(0).toUpperCase()}
              </Text>
            </View>
            <View className="flex-row items-center gap-1 flex-1">
              <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                {role.author}
              </Text>
              {role.authorVerified && (
                <CheckCircle2 size={10} className="text-blue-600" />
              )}
            </View>
          </View>

          {/* Category */}
          <View className="px-2 py-1 bg-muted rounded-md self-start mb-3">
            <Text className="text-xs text-muted-foreground">
              {role.category}
            </Text>
          </View>

          {/* Stats */}
          <View className="flex-row items-center gap-3">
            {role.rating !== undefined && (
              <View className="flex-row items-center gap-0.5">
                <Star size={10} className="text-amber-500" fill="#f59e0b" />
                <Text className="text-xs font-semibold text-foreground">{role.rating}</Text>
              </View>
            )}
            {role.usageCount !== undefined && (
              <View className="flex-row items-center gap-0.5">
                <Users size={10} className="text-muted-foreground" />
                <Text className="text-xs text-muted-foreground">
                  {role.usageCount > 1000 ? `${(role.usageCount / 1000).toFixed(1)}k` : role.usageCount}
                </Text>
              </View>
            )}
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

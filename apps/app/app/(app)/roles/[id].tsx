import React, { useEffect } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Star,
  Users,
  GitFork,
  CheckCircle2,
  ThumbsUp,
  ThumbsDown,
  Sparkles,
  Flame,
  ArrowLeft,
  MessageSquare
} from 'lucide-react-native';
import { useRolesStore } from '@/lib/stores/roles-store';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { toast } from '@/components/sonner';

export default function RoleDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const roles = useRolesStore((state) => state.roles);
  const loadRoles = useRolesStore((state) => state.loadRoles);
  const incrementUsage = useRolesStore((state) => state.incrementUsage);
  const router = useRouter();

  const role = roles.find((r) => r.id === id);

  useEffect(() => {
    if (roles.length === 0) {
      loadRoles();
    }
  }, [roles, loadRoles]);

  const handleStartChat = async () => {
    if (!role) return;

    // Increment usage count
    await incrementUsage(role.id);

    // Navigate to home page with role
    router.replace({ pathname: '/(app)', params: { roleId: role.id } });
  };

  const handleFork = () => {
    toast.info('Fork functionality coming soon!');
  };

  if (!role) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-muted-foreground">Role not found</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="border-b border-border/50 px-6 py-4">
        <View className="flex-row items-center gap-3">
          <Pressable onPress={() => router.back()} className="active:opacity-70">
            <ArrowLeft size={24} className="text-foreground" />
          </Pressable>
          <Text className="text-xl font-bold text-foreground">Role Details</Text>
        </View>
      </View>

      <ScrollView className="flex-1">
        <View className="px-6 py-6">
          {/* Hero Section */}
          <View className="mb-6">
            <View className="flex-row items-start justify-between mb-2">
              <View className="flex-1 pr-4">
                <Text className="text-3xl font-bold text-foreground mb-2">
                  {role.name}
                </Text>
                {role.tagline && (
                  <Text className="text-base text-muted-foreground mb-3">
                    {role.tagline}
                  </Text>
                )}
              </View>

              {/* Badges */}
              <View className="flex-col gap-1">
                {role.isFeatured && (
                  <View className="bg-amber-500/20 px-2 py-0.5 rounded-full flex-row items-center gap-1">
                    <Sparkles size={10} className="text-amber-600" />
                    <Text className="text-xs font-medium text-amber-600">Featured</Text>
                  </View>
                )}
                {role.isTrending && (
                  <View className="bg-orange-500/20 px-2 py-0.5 rounded-full flex-row items-center gap-1">
                    <Flame size={10} className="text-orange-600" />
                    <Text className="text-xs font-medium text-orange-600">Trending</Text>
                  </View>
                )}
                {role.isVerified && (
                  <View className="bg-blue-500/20 px-2 py-0.5 rounded-full flex-row items-center gap-1">
                    <CheckCircle2 size={10} className="text-blue-600" />
                    <Text className="text-xs font-medium text-blue-600">Verified</Text>
                  </View>
                )}
              </View>
            </View>

            {/* Stats */}
            <View className="flex-row items-center gap-4 flex-wrap mb-4">
              {role.rating !== undefined && (
                <View className="flex-row items-center gap-1">
                  <Star size={16} className="text-amber-500" fill="#f59e0b" />
                  <Text className="text-base font-semibold text-foreground">{role.rating}</Text>
                  {role.reviewCount !== undefined && (
                    <Text className="text-sm text-muted-foreground">({role.reviewCount})</Text>
                  )}
                </View>
              )}
              {role.usageCount !== undefined && (
                <View className="flex-row items-center gap-1">
                  <Users size={16} className="text-muted-foreground" />
                  <Text className="text-sm text-muted-foreground">{role.usageCount.toLocaleString()} uses</Text>
                </View>
              )}
              {role.forkCount !== undefined && (
                <View className="flex-row items-center gap-1">
                  <GitFork size={16} className="text-muted-foreground" />
                  <Text className="text-sm text-muted-foreground">{role.forkCount} forks</Text>
                </View>
              )}
              {role.version && (
                <View className="px-2 py-1 bg-muted rounded-md">
                  <Text className="text-xs text-muted-foreground">v{role.version}</Text>
                </View>
              )}
            </View>

            {/* Author & Category */}
            <View className="flex-row items-center gap-2 flex-wrap mb-4">
              <View className="px-2 py-1 bg-muted rounded-md">
                <Text className="text-sm text-muted-foreground">{role.category}</Text>
              </View>
              <View className="flex-row items-center gap-1">
                <Text className="text-sm text-muted-foreground">by {role.author}</Text>
                {role.authorVerified && (
                  <CheckCircle2 size={14} className="text-blue-600" />
                )}
              </View>
            </View>

            {/* Action Buttons */}
            <View className="flex-row gap-2">
              <Button
                onPress={handleStartChat}
                className="flex-1 h-12 rounded-full"
              >
                <View className="flex-row items-center gap-2">
                  <MessageSquare size={18} className="text-primary-foreground" />
                  <Text className="text-sm font-semibold text-primary-foreground">
                    Start Chat
                  </Text>
                </View>
              </Button>
              <Button
                variant="outline"
                onPress={handleFork}
                className="h-12 px-4 rounded-full"
              >
                <View className="flex-row items-center gap-2">
                  <GitFork size={18} className="text-foreground" />
                  <Text className="text-sm font-medium text-foreground">Fork</Text>
                </View>
              </Button>
            </View>
          </View>

          {/* Description */}
          <Card className="mb-4">
            <CardContent className="p-4">
              <Text className="text-base text-foreground">
                {role.description}
              </Text>
            </CardContent>
          </Card>

          {/* Use Case */}
          {role.useCase && (
            <Card className="mb-4">
              <CardContent className="p-4">
                <Text className="text-sm font-semibold text-foreground mb-2">When to use:</Text>
                <Text className="text-sm text-muted-foreground">{role.useCase}</Text>
              </CardContent>
            </Card>
          )}

          {/* Good At / Not Good At */}
          {(role.goodAt || role.notGoodAt) && (
            <View className="flex-row gap-3 mb-4">
              {role.goodAt && role.goodAt.length > 0 && (
                <Card className="flex-1">
                  <CardContent className="p-4">
                    <View className="flex-row items-center gap-2 mb-3">
                      <ThumbsUp size={16} className="text-green-600" />
                      <Text className="text-sm font-semibold text-foreground">Good at:</Text>
                    </View>
                    <View className="gap-2">
                      {role.goodAt.map((item: string, i: number) => (
                        <View key={i} className="flex-row items-start gap-2">
                          <Text className="text-sm text-muted-foreground">•</Text>
                          <Text className="text-sm text-muted-foreground flex-1">{item}</Text>
                        </View>
                      ))}
                    </View>
                  </CardContent>
                </Card>
              )}
              {role.notGoodAt && role.notGoodAt.length > 0 && (
                <Card className="flex-1">
                  <CardContent className="p-4">
                    <View className="flex-row items-center gap-2 mb-3">
                      <ThumbsDown size={16} className="text-orange-600" />
                      <Text className="text-sm font-semibold text-foreground">Not for:</Text>
                    </View>
                    <View className="gap-2">
                      {role.notGoodAt.map((item: string, i: number) => (
                        <View key={i} className="flex-row items-start gap-2">
                          <Text className="text-sm text-muted-foreground">•</Text>
                          <Text className="text-sm text-muted-foreground flex-1">{item}</Text>
                        </View>
                      ))}
                    </View>
                  </CardContent>
                </Card>
              )}
            </View>
          )}

          {/* Example Prompts */}
          {role.examplePrompts && role.examplePrompts.length > 0 && (
            <Card className="mb-4">
              <CardContent className="p-4">
                <Text className="text-sm font-semibold text-foreground mb-3">Try these prompts:</Text>
                <View className="gap-2">
                  {role.examplePrompts.map((prompt: string, i: number) => (
                    <View key={i} className="p-3 bg-muted/50 rounded-lg border border-border/50">
                      <Text className="text-sm text-foreground">"{prompt}"</Text>
                    </View>
                  ))}
                </View>
              </CardContent>
            </Card>
          )}

          {/* Additional Details */}
          <View className="gap-3">
            {role.reasoning && (
              <Card>
                <CardContent className="p-4">
                  <Text className="text-xs font-semibold text-muted-foreground mb-1">Reasoning:</Text>
                  <Text className="text-sm text-foreground">{role.reasoning}</Text>
                </CardContent>
              </Card>
            )}
            {role.writingStyle && (
              <Card>
                <CardContent className="p-4">
                  <Text className="text-xs font-semibold text-muted-foreground mb-1">Writing Style:</Text>
                  <Text className="text-sm text-foreground">{role.writingStyle}</Text>
                </CardContent>
              </Card>
            )}
            {role.tone && (
              <Card>
                <CardContent className="p-4">
                  <Text className="text-xs font-semibold text-muted-foreground mb-1">Tone:</Text>
                  <Text className="text-sm text-foreground">{role.tone}</Text>
                </CardContent>
              </Card>
            )}
            {role.priorities && role.priorities.length > 0 && (
              <Card>
                <CardContent className="p-4">
                  <Text className="text-xs font-semibold text-muted-foreground mb-2">Priorities:</Text>
                  <View className="flex-row flex-wrap gap-2">
                    {role.priorities.map((priority: string, index: number) => (
                      <View key={index} className="px-3 py-1 bg-muted rounded-full">
                        <Text className="text-xs text-foreground">{priority}</Text>
                      </View>
                    ))}
                  </View>
                </CardContent>
              </Card>
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

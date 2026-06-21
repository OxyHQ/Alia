import React, { useEffect } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import {
  GitFork,
  CheckCircle2,
  ArrowLeft,
  MessageSquare,
} from 'lucide-react-native';
import { useRolesStore } from '@/lib/stores/roles-store';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { toast } from '@/components/sonner';
import { useTranslation } from '@/hooks/useTranslation';
import { StatsRow, SectionLabel, PromptChipList, GoodAtNotFor, PillList } from '@/components/detail';

export default function RoleDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const roles = useRolesStore((state) => state.roles);
  const loadRoles = useRolesStore((state) => state.loadRoles);
  const incrementUsage = useRolesStore((state) => state.incrementUsage);
  const router = useRouter();
  const { t } = useTranslation();

  const role = roles.find((r) => r.id === id);

  useEffect(() => {
    if (roles.length === 0) {
      loadRoles();
    }
  }, [roles, loadRoles]);

  const handleStartChat = async () => {
    if (!role) return;
    await incrementUsage(role.id);
    router.replace({ pathname: '/(app)', params: { roleId: role.id } });
  };

  const handleFork = () => {
    toast.info(t('roles.forkComingSoon'));
  };

  if (!role) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-muted-foreground">{t('roles.notFound')}</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="px-5 py-3">
        <Pressable onPress={() => router.back()} className="active:opacity-70 self-start">
          <ArrowLeft size={22} className="text-foreground" />
        </Pressable>
      </View>

      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="px-5 pb-6">
          {/* Identity */}
          <View className="flex-row items-center gap-3 mb-3">
            <View className="w-14 h-14 rounded-2xl bg-muted items-center justify-center">
              <Text className="text-xl font-bold text-foreground">
                {role.name.charAt(0)}
              </Text>
            </View>
            <View className="flex-1">
              <View className="flex-row items-center gap-1.5">
                <Text className="text-xl font-bold text-foreground">
                  {role.name}
                </Text>
                {role.isVerified && (
                  <CheckCircle2 size={16} className="text-blue-500" fill="#3b82f6" strokeWidth={0} />
                )}
              </View>
              <View className="flex-row items-center gap-1">
                <Text className="text-[13px] text-muted-foreground">
                  {role.author}
                </Text>
                {role.authorVerified && (
                  <CheckCircle2 size={11} className="text-blue-500" fill="#3b82f6" strokeWidth={0} />
                )}
                <Text className="text-[13px] text-muted-foreground mx-1">·</Text>
                <Text className="text-[13px] text-muted-foreground">{role.category}</Text>
              </View>
            </View>
          </View>

          {/* Tagline */}
          {role.tagline && (
            <Text className="text-[14px] text-muted-foreground leading-5 mb-3">
              {role.tagline}
            </Text>
          )}

          {/* Stats Row */}
          <StatsRow
            rating={role.rating}
            reviewCount={role.reviewCount}
            usageCount={role.usageCount}
            forkCount={role.forkCount}
            version={role.version}
          />

          {/* Action Buttons */}
          <View className="flex-row gap-2 mb-5">
            <Button
              onPress={handleStartChat}
              className="flex-1 h-11 rounded-full"
            >
              <View className="flex-row items-center gap-2">
                <MessageSquare size={15} className="text-primary-foreground" />
                <Text className="text-[13px] font-semibold text-primary-foreground">
                  {t('roles.startChat')}
                </Text>
              </View>
            </Button>
            <Button
              variant="secondary"
              onPress={handleFork}
              className="h-11 px-4 rounded-full"
            >
              <View className="flex-row items-center gap-1.5">
                <GitFork size={15} className="text-foreground" />
                <Text className="text-[13px] font-medium text-foreground">{t('roles.fork')}</Text>
              </View>
            </Button>
          </View>

          {/* Description */}
          <Text className="text-[14px] text-foreground leading-5 mb-5">
            {role.description}
          </Text>

          {/* When to use */}
          {role.useCase && (
            <View className="mb-5">
              <SectionLabel>{t('roles.whenToUse')}</SectionLabel>
              <Text className="text-[13px] text-foreground leading-5">{role.useCase}</Text>
            </View>
          )}

          {/* Good At / Not For */}
          <GoodAtNotFor goodAt={role.goodAt} notGoodAt={role.notGoodAt} />

          {/* Example Prompts */}
          {role.examplePrompts && role.examplePrompts.length > 0 && (
            <View className="mb-5">
              <SectionLabel>{t('roles.tryPrompts')}</SectionLabel>
              <PromptChipList items={role.examplePrompts} />
            </View>
          )}

          {/* Details */}
          {(role.reasoning || role.writingStyle || role.tone) && (
            <View className="mb-5">
              <View className="gap-3">
                {role.tone && (
                  <View className="flex-row">
                    <Text className="text-[12px] text-muted-foreground w-20">{t('roles.tone')}</Text>
                    <Text className="text-[13px] text-foreground flex-1">{role.tone}</Text>
                  </View>
                )}
                {role.writingStyle && (
                  <View className="flex-row">
                    <Text className="text-[12px] text-muted-foreground w-20">{t('roles.writingStyle')}</Text>
                    <Text className="text-[13px] text-foreground flex-1">{role.writingStyle}</Text>
                  </View>
                )}
                {role.reasoning && (
                  <View className="flex-row">
                    <Text className="text-[12px] text-muted-foreground w-20">{t('roles.reasoning')}</Text>
                    <Text className="text-[13px] text-foreground flex-1">{role.reasoning}</Text>
                  </View>
                )}
              </View>
            </View>
          )}

          {/* Priorities */}
          {role.priorities && role.priorities.length > 0 && (
            <View>
              <SectionLabel>{t('roles.priorities')}</SectionLabel>
              <PillList items={role.priorities} />
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

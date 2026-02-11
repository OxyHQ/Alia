import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Plus, MessageSquare } from 'lucide-react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTranslation } from '@/hooks/useTranslation';
import { toast } from '@/components/sonner';
import { ALL_SKILLS } from '@/lib/data/skills';
import { StatsRow, SectionLabel, BulletList, PromptChipList, GoodAtNotFor } from '@/components/detail';

export default function SkillDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useTranslation();

  const skill = ALL_SKILLS.find((s) => s.id === id);

  if (!skill) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-muted-foreground">{t('skills.notFound')}</Text>
      </View>
    );
  }

  const handleAddToLibrary = () => {
    toast.info(t('skills.comingSoon'));
  };

  const handleUseSkill = () => {
    router.replace({ pathname: '/(app)' });
  };

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
          {/* Identity: book cover + info */}
          <View className="flex-row gap-4 mb-3">
            <View
              className="rounded-sm overflow-hidden"
              style={{
                backgroundColor: skill.color,
                width: 90,
                aspectRatio: 2 / 3,
              }}
            >
              <View className="p-2 pb-0">
                <View
                  className="items-center justify-center"
                  style={{
                    backgroundColor: 'rgba(255,255,255,0.2)',
                    aspectRatio: 16 / 10,
                  }}
                >
                  <Text className="text-lg">{skill.icon}</Text>
                </View>
              </View>
              <View className="flex-1 px-2 pt-1.5 pb-2 justify-between">
                <Text
                  className="text-[11px] font-black leading-3"
                  style={{ color: 'rgba(255,255,255,0.95)' }}
                  numberOfLines={3}
                >
                  {skill.title}
                </Text>
                <Text
                  className="text-[8px]"
                  style={{ color: 'rgba(255,255,255,0.5)' }}
                >
                  {skill.author}
                </Text>
              </View>
            </View>

            <View className="flex-1 justify-center">
              <Text className="text-xl font-bold text-foreground mb-0.5">
                {skill.title}
              </Text>
              <Text className="text-[13px] text-muted-foreground">
                {skill.author} · {skill.date}
              </Text>
            </View>
          </View>

          {/* Tagline */}
          <Text className="text-[14px] text-muted-foreground leading-5 mb-3">
            {skill.tagline}
          </Text>

          {/* Stats Row */}
          <StatsRow
            rating={skill.rating}
            reviewCount={skill.reviewCount}
            usageCount={skill.usageCount}
            forkCount={skill.forkCount}
            version={skill.version}
          />

          {/* Action Buttons */}
          <View className="flex-row gap-2 mb-5">
            <Button
              onPress={handleUseSkill}
              className="flex-1 h-11 rounded-full"
            >
              <View className="flex-row items-center gap-2">
                <MessageSquare size={15} className="text-primary-foreground" />
                <Text className="text-[13px] font-semibold text-primary-foreground">
                  {t('skills.useSkill')}
                </Text>
              </View>
            </Button>
            <Button
              variant="secondary"
              onPress={handleAddToLibrary}
              className="h-11 px-4 rounded-full"
            >
              <View className="flex-row items-center gap-1.5">
                <Plus size={15} className="text-foreground" />
                <Text className="text-[13px] font-medium text-foreground">{t('skills.addToLibrary')}</Text>
              </View>
            </Button>
          </View>

          {/* Description */}
          <Text className="text-[14px] text-foreground leading-5 mb-5">
            {skill.description}
          </Text>

          {/* When to use */}
          {skill.useCase && (
            <View className="mb-5">
              <SectionLabel>{t('roles.whenToUse')}</SectionLabel>
              <Text className="text-[13px] text-foreground leading-5">{skill.useCase}</Text>
            </View>
          )}

          {/* Good At / Not For */}
          <GoodAtNotFor goodAt={skill.goodAt} notGoodAt={skill.notGoodAt} />

          {/* Triggers */}
          {skill.triggers.length > 0 && (
            <View className="mb-5">
              <SectionLabel>{t('skills.triggers')}</SectionLabel>
              <PromptChipList items={skill.triggers} />
            </View>
          )}

          {/* Includes */}
          {skill.includes.length > 0 && (
            <View>
              <SectionLabel>{t('skills.includes')}</SectionLabel>
              <BulletList items={skill.includes} color="primary" />
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

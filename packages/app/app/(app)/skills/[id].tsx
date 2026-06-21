import { useState, useEffect } from 'react';
import { View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Pencil, MessageSquare } from 'lucide-react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTranslation } from '@/hooks/useTranslation';
import { useSkillsStore, type Skill } from '@/lib/stores/skills-store';
import { SectionLabel, BulletList, PromptChipList, GoodAtNotFor } from '@/components/detail';
import { SkillCover } from '@/components/ui/skill-cover';

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en', { month: 'short', year: 'numeric' });
}

export default function SkillDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const { skills, getSkill } = useSkillsStore();

  const [skill, setSkill] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const cached = skills.find((s) => s.skillId === id);
    if (cached) {
      setSkill(cached);
      setLoading(false);
    } else if (id) {
      getSkill(id).then((s) => {
        setSkill(s);
        setLoading(false);
      });
    }
  }, [id, skills, getSkill]);

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator />
      </View>
    );
  }

  if (!skill) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-muted-foreground">{t('skills.notFound')}</Text>
      </View>
    );
  }

  const handleUseSkill = () => {
    router.replace({ pathname: '/(app)', params: { skillId: skill.skillId } });
  };

  const handleEdit = () => {
    router.push(`/(app)/skills/edit/${skill.skillId}` as any);
  };

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="px-5 py-3 flex-row items-center justify-between">
        <Pressable onPress={() => router.back()} className="active:opacity-70">
          <ArrowLeft size={22} className="text-foreground" />
        </Pressable>
        {!skill.isBuiltIn && skill.oxyUserId && (
          <Pressable onPress={handleEdit} className="active:opacity-70">
            <Pencil size={18} className="text-foreground" />
          </Pressable>
        )}
      </View>

      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="px-5 pb-6">
          {/* Identity: book cover + info */}
          <View className="flex-row gap-4 mb-3">
            <SkillCover seed={skill.title} width={90} title={skill.title} author={skill.author} updatedAt={skill.updatedAt} />

            <View className="flex-1 justify-center">
              <Text className="text-xl font-bold text-foreground mb-0.5">
                {skill.title}
              </Text>
              <Text className="text-[13px] text-muted-foreground">
                {skill.author} · {formatDate(skill.createdAt)}
              </Text>
              <View className="flex-row items-center gap-1.5 mt-1">
                <View className="bg-muted px-2 py-0.5 rounded">
                  <Text className="text-[10px] font-medium text-muted-foreground uppercase">
                    {skill.language}
                  </Text>
                </View>
                {!skill.isPublished && !skill.isBuiltIn && (
                  <View className="bg-muted px-2 py-0.5 rounded">
                    <Text className="text-[10px] font-medium text-muted-foreground">
                      {t('skills.draft')}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          </View>

          {/* Tagline */}
          <Text className="text-[14px] text-muted-foreground leading-5 mb-3">
            {skill.tagline}
          </Text>

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

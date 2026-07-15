import { useEffect, useMemo, useState, useCallback } from 'react';
import { View, ScrollView, Pressable, RefreshControl } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react-native';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useRouter } from 'expo-router';
import { useSkillsStore, type Skill } from '@/lib/stores/skills-store';
import { useI18nStore } from '@/lib/stores/i18n-store';
import { SkillCover } from '@/components/ui/skill-cover';
import { Skeleton } from '@/components/ui/skeleton';

function SkillBook({ skill, onPress }: { skill: Skill; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} className="active:opacity-80 mr-2.5">
      <SkillCover seed={skill.title} width={110} title={skill.title} author={skill.author} updatedAt={skill.updatedAt} />
    </Pressable>
  );
}

function ShelfSection({ title, skills, onPressSkill }: { title: string; skills: Skill[]; onPressSkill: (id: string) => void }) {
  if (skills.length === 0) return null;
  return (
    <View className="mb-5">
      <View className="px-5 mb-2">
        <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">{title}</Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 20 }}
      >
        {skills.map((skill) => (
          <SkillBook key={skill.skillId} skill={skill} onPress={() => onPressSkill(skill.skillId)} />
        ))}
      </ScrollView>
    </View>
  );
}

export default function SkillsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const locale = useI18nStore((s) => s.locale);
  const skills = useSkillsStore((s) => s.skills);
  const loading = useSkillsStore((s) => s.loading);
  const loadSkills = useSkillsStore((s) => s.loadSkills);

  useEffect(() => {
    const lang = locale.split('-')[0];
    loadSkills({ language: lang });
  }, [locale, loadSkills]);

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const lang = locale.split('-')[0];
    await loadSkills({ language: lang });
    setRefreshing(false);
  }, [locale, loadSkills]);

  const featured = useMemo(() => skills.filter((s) => s.category === 'featured'), [skills]);
  const community = useMemo(() => skills.filter((s) => s.category === 'community'), [skills]);
  const recent = useMemo(() => skills.filter((s) => s.category === 'recent'), [skills]);

  const handlePressSkill = (skillId: string) => {
    router.push(`/(app)/skills/${skillId}`);
  };

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Header */}
        <View className="px-5 pt-6 pb-4">
          <View className="flex-row items-center justify-between">
            <Text className="text-2xl font-bold text-foreground">
              {t('skills.title')}
            </Text>
            <Button
              size="icon"
              className="rounded-full h-8 w-8"
              onPress={() => router.push('/(app)/skills/create')}
            >
              <Plus size={16} className="text-primary-foreground" />
            </Button>
          </View>
          <Text className="text-[13px] text-muted-foreground mt-0.5">
            {t('skills.subtitle')}
          </Text>
        </View>

        {loading && skills.length === 0 ? (
          <>
            {Array.from({ length: 3 }).map((_, shelfIdx) => (
              <View key={shelfIdx} className="mb-5">
                <View className="px-5 mb-2">
                  <Skeleton style={{ width: 80, height: 10, borderRadius: 6 }} />
                </View>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ paddingHorizontal: 20, gap: 10 }}
                >
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} style={{ width: 110, height: 160, borderRadius: 8 }} />
                  ))}
                </ScrollView>
              </View>
            ))}
          </>
        ) : (
          <>
            <ShelfSection title="Featured" skills={featured} onPressSkill={handlePressSkill} />
            <ShelfSection title="Community" skills={community} onPressSkill={handlePressSkill} />
            <ShelfSection title={t('skills.recentlyAdded')} skills={recent} onPressSkill={handlePressSkill} />
          </>
        )}
      </ScrollView>
    </View>
  );
}

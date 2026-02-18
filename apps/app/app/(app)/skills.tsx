import { useEffect, useMemo } from 'react';
import { View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react-native';
import { useTranslation } from '@/hooks/useTranslation';
import { useRouter } from 'expo-router';
import { useSkillsStore, type Skill } from '@/lib/stores/skills-store';
import { useI18nStore } from '@/lib/stores/i18n-store';

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en', { month: 'short', year: 'numeric' });
}

function SkillBook({ skill, onPress }: { skill: Skill; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className="rounded-sm overflow-hidden active:opacity-80 mr-2.5"
      style={{
        backgroundColor: skill.color,
        width: 110,
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
          <Text className="text-xl">{skill.icon}</Text>
        </View>
      </View>
      <View className="flex-1 px-2 pt-1.5 pb-2 justify-between">
        <Text
          className="text-[13px] font-black leading-4"
          style={{ color: 'rgba(255,255,255,0.95)' }}
          numberOfLines={3}
        >
          {skill.title}
        </Text>
        <View className="mt-1">
          <Text
            className="text-[10px]"
            style={{ color: 'rgba(255,255,255,0.6)' }}
            numberOfLines={1}
          >
            {skill.author}
          </Text>
          <Text
            className="text-[10px]"
            style={{ color: 'rgba(255,255,255,0.5)' }}
          >
            {formatDate(skill.createdAt)}
          </Text>
        </View>
      </View>
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
  const { skills, loading, loadSkills } = useSkillsStore();

  useEffect(() => {
    const lang = locale.split('-')[0];
    loadSkills({ language: lang });
  }, [locale, loadSkills]);

  const featured = useMemo(() => skills.filter((s) => s.category === 'featured'), [skills]);
  const community = useMemo(() => skills.filter((s) => s.category === 'community'), [skills]);
  const recent = useMemo(() => skills.filter((s) => s.category === 'recent'), [skills]);

  const handlePressSkill = (skillId: string) => {
    router.push(`/(app)/skills/${skillId}`);
  };

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
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

        {loading ? (
          <View className="py-12 items-center">
            <ActivityIndicator />
          </View>
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

import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react-native';
import { useTranslation } from '@/hooks/useTranslation';
import { useRouter } from 'expo-router';
import { FEATURED_SKILLS, COMMUNITY_SKILLS, RECENT_SKILLS, type Skill } from '@/lib/data/skills';

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
            {skill.date}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

function ShelfSection({ title, skills, onPressSkill }: { title: string; skills: Skill[]; onPressSkill: (id: string) => void }) {
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
          <SkillBook key={skill.id} skill={skill} onPress={() => onPressSkill(skill.id)} />
        ))}
      </ScrollView>
    </View>
  );
}

export default function SkillsScreen() {
  const { t } = useTranslation();
  const router = useRouter();

  const handlePressSkill = (id: string) => {
    router.push(`/(app)/skills/${id}`);
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
            >
              <Plus size={16} className="text-primary-foreground" />
            </Button>
          </View>
          <Text className="text-[13px] text-muted-foreground mt-0.5">
            {t('skills.subtitle')}
          </Text>
        </View>

        {/* Shelves */}
        <ShelfSection title="Featured" skills={FEATURED_SKILLS} onPressSkill={handlePressSkill} />
        <ShelfSection title="Community" skills={COMMUNITY_SKILLS} onPressSkill={handlePressSkill} />
        <ShelfSection title="Recently Added" skills={RECENT_SKILLS} onPressSkill={handlePressSkill} />
      </ScrollView>
    </View>
  );
}

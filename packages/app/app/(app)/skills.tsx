import { useMemo, useState } from 'react';
import { View, ScrollView, Pressable, RefreshControl } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Check, Download, Plus, Search } from 'lucide-react-native';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useRouter } from 'expo-router';
import {
  useInstallSkill,
  useInstalledSkills,
  useSkillCatalogue,
  type InstalledSkill,
  type Skill,
} from '@/lib/hooks/use-skills';
import { SkillCover } from '@/components/ui/skill-cover';
import { Skeleton } from '@/components/ui/skeleton';
import { ContentPanel } from '@oxyhq/bloom/content-panel';

/**
 * The Skills catalogue.
 *
 * Two questions, kept apart because they are different: what EXISTS (the
 * catalogue, which anybody can browse) and what this account has INSTALLED,
 * which is the only thing the model can reach. A skill on the shelf is marked as
 * such wherever it appears, so "installed" is never something to go and check.
 */

function SkillBook({
  skill,
  installed,
  onPress,
  onInstall,
}: {
  skill: Skill;
  installed: boolean;
  onPress: () => void;
  onInstall: () => void;
}) {
  return (
    <View className="mr-2.5 w-[110px]">
      <Pressable onPress={onPress} className="active:opacity-80">
        <SkillCover
          seed={skill.name}
          width={110}
          color={skill.color ?? undefined}
          title={skill.displayName}
          author={skill.publisher ?? undefined}
          updatedAt={skill.updatedAt}
        />
      </Pressable>
      <Button
        size="sm"
        variant={installed ? 'secondary' : 'outline'}
        className="mt-1.5 h-7 rounded-full"
        disabled={installed}
        onPress={onInstall}
      >
        {installed ? (
          <Check size={12} className="text-muted-foreground" />
        ) : (
          <Download size={12} className="text-foreground" />
        )}
      </Button>
    </View>
  );
}

function Shelf({
  title,
  skills,
  installedIds,
  onPressSkill,
  onInstall,
}: {
  title: string;
  skills: Skill[];
  installedIds: Set<string>;
  onPressSkill: (name: string) => void;
  onInstall: (id: string) => void;
}) {
  if (skills.length === 0) return null;
  return (
    <ContentPanel surfaceClassName="bg-background">
      <View className="mb-5">
        <View className="px-5 mb-2">
          <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">{title}</Text>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20 }}>
          {skills.map((skill) => (
            <SkillBook
              key={skill._id}
              skill={skill}
              installed={installedIds.has(skill._id)}
              onPress={() => onPressSkill(skill.name)}
              onInstall={() => onInstall(skill._id)}
            />
          ))}
        </ScrollView>
      </View>
    </ContentPanel>
  );
}

export default function SkillsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const [search, setSearch] = useState('');

  const catalogue = useSkillCatalogue(search.trim() ? { query: search.trim() } : {});
  const installed = useInstalledSkills();
  const install = useInstallSkill();

  const installedIds = useMemo(
    () => new Set((installed.data ?? []).map((skill: InstalledSkill) => skill._id)),
    [installed.data],
  );

  const skills = catalogue.data ?? [];
  const official = useMemo(() => skills.filter((skill) => skill.source === 'builtin' || skill.source === 'registry'), [skills]);
  const community = useMemo(() => skills.filter((skill) => skill.source !== 'builtin' && skill.source !== 'registry'), [skills]);

  const openSkill = (name: string) => router.push(`/(app)/skills/${name}`);

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={catalogue.isFetching && !catalogue.isLoading}
            onRefresh={() => {
              void catalogue.refetch();
              void installed.refetch();
            }}
          />
        }
      >
        <View className="px-5 pt-6 pb-4">
          <View className="flex-row items-center justify-between">
            <Text className="text-2xl font-bold text-foreground">{t('skills.title')}</Text>
            <View className="flex-row gap-2">
              <Button
                size="icon"
                variant="outline"
                className="rounded-full h-8 w-8"
                onPress={() => router.push('/(app)/skills/import')}
              >
                <Download size={16} className="text-foreground" />
              </Button>
              <Button size="icon" className="rounded-full h-8 w-8" onPress={() => router.push('/(app)/skills/create')}>
                <Plus size={16} className="text-primary-foreground" />
              </Button>
            </View>
          </View>
          <Text className="text-[13px] text-muted-foreground mt-0.5">{t('skills.subtitle')}</Text>

          <View className="mt-3 flex-row items-center gap-2 rounded-full border border-border px-3">
            <Search size={14} className="text-muted-foreground" />
            <Input
              value={search}
              onChangeText={setSearch}
              placeholder={t('skills.searchPlaceholder')}
              className="flex-1 border-0 bg-transparent px-0"
            />
          </View>
        </View>

        {catalogue.isLoading ? (
          <View className="mb-5">
            <View className="px-5 mb-2">
              <Skeleton style={{ width: 80, height: 10, borderRadius: 6 }} />
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, gap: 10 }}>
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} style={{ width: 110, height: 160, borderRadius: 8 }} />
              ))}
            </ScrollView>
          </View>
        ) : (
          <>
            {(installed.data ?? []).length > 0 ? (
              <Shelf
                title={t('skills.installed')}
                skills={installed.data ?? []}
                installedIds={installedIds}
                onPressSkill={openSkill}
                onInstall={(id) => install.mutate(id)}
              />
            ) : null}
            <Shelf
              title={t('skills.official')}
              skills={official}
              installedIds={installedIds}
              onPressSkill={openSkill}
              onInstall={(id) => install.mutate(id)}
            />
            <Shelf
              title={t('skills.community')}
              skills={community}
              installedIds={installedIds}
              onPressSkill={openSkill}
              onInstall={(id) => install.mutate(id)}
            />

            {/* An empty catalogue is a real state — a fresh database before the
                registry sync has run — and saying so beats a blank screen. */}
            {skills.length === 0 ? (
              <View className="px-5 py-10 items-center">
                <Text className="text-[13px] text-muted-foreground text-center">
                  {search.trim() ? t('skills.noResults') : t('skills.empty')}
                </Text>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

import { View, ScrollView, Pressable, ActivityIndicator, Linking } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ArrowLeft, Check, Download, ExternalLink, FileText, Pencil, Play, Trash2 } from 'lucide-react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useOxy } from '@oxyhq/services';
import { useTranslation } from '@/lib/hooks/use-translation';
import {
  useInstallSkill,
  useInstalledSkills,
  useSkill,
  useUninstallSkill,
  useUpdateInstall,
  type InstalledSkill,
} from '@/lib/hooks/use-skills';
import { SectionLabel } from '@/components/detail/section-label';
import { CustomMarkdown } from '@/components/ui/markdown';
import { SkillCover } from '@/components/ui/skill-cover';
import { ContentPanel } from '@oxyhq/bloom/content-panel';

/**
 * One skill, in full.
 *
 * The instructions are SHOWN rather than hidden. A skill is somebody else's
 * prompt that will run inside your conversations, and the only honest way to
 * decide whether to install one is to read what it says — which is also why the
 * publisher and the exact source commit are on this screen rather than in a
 * tooltip.
 */

const KIND_ICON = {
  reference: FileText,
  script: Play,
  asset: FileText,
} as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function SkillDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const { user } = useOxy();

  const detail = useSkill(id);
  const installed = useInstalledSkills();
  const install = useInstallSkill();
  const uninstall = useUninstallSkill();
  const updateInstall = useUpdateInstall();

  if (detail.isLoading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator />
      </View>
    );
  }

  if (!detail.data) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-muted-foreground">{t('skills.notFound')}</Text>
      </View>
    );
  }

  const { skill, version, files } = detail.data;
  const shelf: InstalledSkill | undefined = (installed.data ?? []).find((entry) => entry._id === skill._id);
  const isOwner = Boolean(user?.id && skill.ownerOxyUserId === user.id);

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="flex-row items-center justify-between px-4 pt-4">
          <Pressable onPress={() => router.back()} className="h-9 w-9 items-center justify-center rounded-full active:bg-muted">
            <ArrowLeft size={18} className="text-foreground" />
          </Pressable>
          {isOwner ? (
            <Pressable
              onPress={() => router.push(`/(app)/skills/edit/${skill._id}`)}
              className="h-9 w-9 items-center justify-center rounded-full active:bg-muted"
            >
              <Pencil size={16} className="text-foreground" />
            </Pressable>
          ) : null}
        </View>

        <ContentPanel surfaceClassName="bg-background">
          <View className="px-5 pt-2 pb-4 flex-row gap-4">
            <SkillCover seed={skill.name} width={96} color={skill.color ?? undefined} title={skill.displayName} />
            <View className="flex-1">
              <Text className="text-xl font-bold text-foreground">{skill.displayName}</Text>
              <Text className="text-[12px] text-muted-foreground mt-0.5">{skill.name}</Text>
              {skill.publisher ? (
                <Text className="text-[12px] text-muted-foreground mt-1">
                  {t('skills.publisher')}: {skill.publisher}
                </Text>
              ) : null}
              {skill.license ? (
                <Text className="text-[12px] text-muted-foreground">
                  {t('skills.license')}: {skill.license}
                </Text>
              ) : null}

              <View className="mt-3">
                {shelf ? (
                  <Button size="sm" variant="outline" className="rounded-full" onPress={() => uninstall.mutate(skill._id)}>
                    <Check size={13} className="text-foreground" />
                    <Text className="ml-1.5">{t('skills.uninstall')}</Text>
                  </Button>
                ) : (
                  <Button size="sm" className="rounded-full" disabled={install.isPending} onPress={() => install.mutate(skill._id)}>
                    <Download size={13} className="text-primary-foreground" />
                    <Text className="ml-1.5">{install.isPending ? t('skills.installing') : t('skills.install')}</Text>
                  </Button>
                )}
              </View>
            </View>
          </View>

          <View className="px-5 pb-4">
            <Text className="text-[14px] leading-5 text-foreground">{skill.description}</Text>
          </View>
        </ContentPanel>

        {shelf ? (
          <ContentPanel surfaceClassName="bg-background">
            <View className="px-5 py-4 gap-4">
              <View className="flex-row items-center justify-between">
                <View className="flex-1 pr-4">
                  <Text className="text-[14px] text-foreground">{t('skills.enabled')}</Text>
                  <Text className="text-[12px] text-muted-foreground mt-0.5">{t('skills.enabledHint')}</Text>
                </View>
                <Switch
                  value={shelf.enabled}
                  onValueChange={(enabled: boolean) => updateInstall.mutate({ id: skill._id, patch: { enabled } })}
                />
              </View>
              <View className="flex-row items-center justify-between">
                <View className="flex-1 pr-4">
                  <Text className="text-[14px] text-foreground">{t('skills.autoInvoke')}</Text>
                  <Text className="text-[12px] text-muted-foreground mt-0.5">{t('skills.autoInvokeHint')}</Text>
                </View>
                <Switch
                  value={shelf.autoInvoke}
                  onValueChange={(autoInvoke: boolean) => updateInstall.mutate({ id: skill._id, patch: { autoInvoke } })}
                />
              </View>
              <Text className="text-[12px] text-muted-foreground">
                {shelf.pinnedVersion === null
                  ? t('skills.versionFollowLatest')
                  : t('skills.versionPinned', { version: shelf.pinnedVersion })}
              </Text>
            </View>
          </ContentPanel>
        ) : null}

        {skill.compatibility ? (
          <ContentPanel surfaceClassName="bg-background">
            <View className="px-5 py-3">
              <SectionLabel>{t('skills.compatibility')}</SectionLabel>
              <Text className="text-[13px] text-muted-foreground mt-1">{skill.compatibility}</Text>
            </View>
          </ContentPanel>
        ) : null}

        {skill.allowedTools.length > 0 ? (
          <ContentPanel surfaceClassName="bg-background">
            <View className="px-5 py-3">
              <SectionLabel>{t('skills.declaredTools')}</SectionLabel>
              <View className="flex-row flex-wrap gap-1.5 mt-2">
                {skill.allowedTools.map((tool) => (
                  <View key={tool} className="rounded-full border border-border px-2.5 py-1">
                    <Text className="text-[11px] text-muted-foreground">{tool}</Text>
                  </View>
                ))}
              </View>
            </View>
          </ContentPanel>
        ) : null}

        <ContentPanel surfaceClassName="bg-background">
          <View className="px-5 py-3">
            <SectionLabel>{t('skills.instructions')}</SectionLabel>
            {skill.publisher ? (
              <Text className="text-[11px] text-muted-foreground mt-1 mb-2">
                {t('skills.untrusted', { publisher: skill.publisher })}
              </Text>
            ) : null}
            {version ? <CustomMarkdown content={version.body} /> : null}
          </View>
        </ContentPanel>

        <ContentPanel surfaceClassName="bg-background">
          <View className="px-5 py-3">
            <SectionLabel>{t('skills.files')}</SectionLabel>
            {files.length === 0 ? (
              <Text className="text-[13px] text-muted-foreground mt-1">{t('skills.noFiles')}</Text>
            ) : (
              <View className="mt-2 gap-1.5">
                {files.map((file) => {
                  const Icon = KIND_ICON[file.kind];
                  return (
                    <View key={file.path} className="flex-row items-center gap-2">
                      <Icon size={13} className="text-muted-foreground" />
                      <Text className="text-[13px] text-foreground flex-1">{file.path}</Text>
                      <Text className="text-[11px] text-muted-foreground">{formatBytes(file.bytes)}</Text>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        </ContentPanel>

        {skill.sourceUrl ? (
          <ContentPanel surfaceClassName="bg-background">
            <Pressable
              className="px-5 py-3 flex-row items-center gap-2 active:opacity-70"
              onPress={() => void Linking.openURL(skill.sourceUrl!)}
            >
              <ExternalLink size={14} className="text-muted-foreground" />
              <View className="flex-1">
                <Text className="text-[13px] text-foreground">{t('skills.viewSource')}</Text>
                <Text className="text-[11px] text-muted-foreground">
                  {skill.sourceRepo}
                  {version?.sourceCommit ? ` · ${version.sourceCommit.slice(0, 7)}` : ''}
                </Text>
              </View>
            </Pressable>
          </ContentPanel>
        ) : null}

        <View className="h-10" />
      </ScrollView>
    </View>
  );
}

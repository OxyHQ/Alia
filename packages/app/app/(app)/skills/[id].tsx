import { CustomMarkdown } from '@/components/ui/markdown';
import { SkillCover } from '@/components/ui/skill-cover';
import {
  useInstallSkill,
  useInstalledSkills,
  useSkill,
  useUninstallSkill,
  useUpdateInstall,
  type InstalledSkill,
} from '@/lib/hooks/use-skills';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { RiDownloadLine } from '@oxy.so/bloom/icons/RiDownloadLine';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons/RiExternalLinkLine';
import { RiFileTextLine } from '@oxy.so/bloom/icons/RiFileTextLine';
import { RiPencilLine } from '@oxy.so/bloom/icons/RiPencilLine';
import { RiPlayLine } from '@oxy.so/bloom/icons/RiPlayLine';
import { Loading } from '@oxy.so/bloom/loading';
import {
  SettingsListGroup,
  SettingsListItem,
} from '@oxy.so/bloom/settings-list';
import { Switch } from '@oxy.so/bloom/switch';
import { useTheme } from '@oxy.so/bloom/theme';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useOxy } from '@oxy.so/services';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Linking, ScrollView, View } from 'react-native';

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
  reference: RiFileTextLine,
  script: RiPlayLine,
  asset: RiFileTextLine,
} as const;

/** Stacking only: the column the page reads in. */
const CONTENT = {
  width: '100%',
  maxWidth: 768,
  alignSelf: 'center',
  paddingHorizontal: 16,
  paddingTop: 16,
  paddingBottom: 48,
  gap: 24,
} as const;
/** Stacking only: the top row of actions. */
const ACTIONS = {
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 8,
} as const;
/** Stacking only: the cover beside the skill's identity. */
const HERO = { flexDirection: 'row', gap: 16 } as const;
const IDENTITY = { flex: 1, gap: 4, alignItems: 'flex-start' } as const;
/** Stacking only: a section, its heading over its content. */
const SECTION = { gap: 8 } as const;
/** Stacking only: the declared tools, wrapping. */
const TAGS = { flexDirection: 'row', flexWrap: 'wrap', gap: 6 } as const;

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
  const { colors } = useTheme();

  const detail = useSkill(id);
  const installed = useInstalledSkills();
  const install = useInstallSkill();
  const uninstall = useUninstallSkill();
  const updateInstall = useUpdateInstall();

  if (detail.isLoading) {
    return <Loading variant="spinner" />;
  }

  if (!detail.data) {
    return (
      <EmptyState
        title={t('skills.notFound')}
        action={{ label: t('common.back'), onPress: () => router.back() }}
      />
    );
  }

  const { skill, version, files } = detail.data;
  const shelf: InstalledSkill | undefined = (installed.data ?? []).find(
    (entry) => entry._id === skill._id,
  );
  const isOwner = Boolean(user?.id && skill.ownerOxyUserId === user.id);

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={CONTENT}
    >
      <View style={ACTIONS}>
        <Button
          tone="neutral"
          appearance="plain"
          size="sm"
          icon={RiArrowLeftLine}
          accessibilityLabel={t('common.back')}
          onPress={() => router.back()}
        />
        {isOwner ? (
          <Button
            tone="neutral"
            appearance="subtle"
            size="sm"
            leadingIcon={RiPencilLine}
            onPress={() => router.push(`/(app)/skills/edit/${skill._id}`)}
          >
            {t('common.edit')}
          </Button>
        ) : null}
      </View>

      <View style={HERO}>
        {/* The one cover on this screen is the one that may move: an
            explicit opt-in, honoured on native only and not under reduced
            motion. Shelves never pass it (#545). */}
        <SkillCover
          seed={skill.name}
          width={96}
          color={skill.color ?? undefined}
          title={skill.displayName}
          animated
        />
        <View style={IDENTITY}>
          <Text variant="title-2-semibold">{skill.displayName}</Text>
          <Muted>{skill.name}</Muted>
          {skill.publisher ? (
            <Muted>
              {t('skills.publisher')}: {skill.publisher}
            </Muted>
          ) : null}
          {skill.license ? (
            <Muted>
              {t('skills.license')}: {skill.license}
            </Muted>
          ) : null}
          {shelf ? (
            <Button
              size="sm"
              tone="neutral"
              appearance="subtle"
              leadingIcon={RiCheckLine}
              onPress={() => uninstall.mutate(skill._id)}
            >
              {t('skills.uninstall')}
            </Button>
          ) : (
            <Button
              size="sm"
              tone="action"
              leadingIcon={RiDownloadLine}
              disabled={install.isPending}
              onPress={() => install.mutate(skill._id)}
            >
              {install.isPending ? t('skills.installing') : t('skills.install')}
            </Button>
          )}
        </View>
      </View>

      <Text variant="body-regular">{skill.description}</Text>

      {shelf ? (
        <SettingsListGroup
          footer={
            shelf.pinnedVersion === null
              ? t('skills.versionFollowLatest')
              : t('skills.versionPinned', { version: shelf.pinnedVersion })
          }
        >
          <SettingsListItem
            title={t('skills.enabled')}
            description={t('skills.enabledHint')}
            rightElement={
              <Switch
                accessibilityLabel={t('skills.enabled')}
                value={shelf.enabled}
                onValueChange={(enabled: boolean) =>
                  updateInstall.mutate({ id: skill._id, patch: { enabled } })
                }
              />
            }
          />
          <SettingsListItem
            title={t('skills.autoInvoke')}
            description={t('skills.autoInvokeHint')}
            rightElement={
              <Switch
                accessibilityLabel={t('skills.autoInvoke')}
                value={shelf.autoInvoke}
                onValueChange={(autoInvoke: boolean) =>
                  updateInstall.mutate({
                    id: skill._id,
                    patch: { autoInvoke },
                  })
                }
              />
            }
          />
        </SettingsListGroup>
      ) : null}

      {skill.compatibility ? (
        <View style={SECTION}>
          <Text variant="headline-semibold">{t('skills.compatibility')}</Text>
          <Muted>{skill.compatibility}</Muted>
        </View>
      ) : null}

      {skill.allowedTools.length > 0 ? (
        <View style={SECTION}>
          <Text variant="headline-semibold">{t('skills.declaredTools')}</Text>
          <View style={TAGS}>
            {skill.allowedTools.map((tool) => (
              <Badge
                key={tool}
                size="label-small"
                variant="outlined"
                color="default"
                content={tool}
              />
            ))}
          </View>
        </View>
      ) : null}

      <View style={SECTION}>
        <Text variant="headline-semibold">{t('skills.instructions')}</Text>
        {skill.publisher ? (
          <Muted>{t('skills.untrusted', { publisher: skill.publisher })}</Muted>
        ) : null}
        {version ? <CustomMarkdown content={version.body} /> : null}
      </View>

      <View style={SECTION}>
        <Text variant="headline-semibold">{t('skills.files')}</Text>
        {files.length === 0 ? (
          <Muted>{t('skills.noFiles')}</Muted>
        ) : (
          <SettingsListGroup>
            {files.map((file) => {
              const Icon = KIND_ICON[file.kind];
              return (
                <SettingsListItem
                  key={file.path}
                  icon={<Icon width={18} height={18} fill={colors.icon} />}
                  title={file.path}
                  value={formatBytes(file.bytes)}
                />
              );
            })}
          </SettingsListGroup>
        )}
      </View>

      {skill.sourceUrl ? (
        <SettingsListGroup>
          <SettingsListItem
            icon={<RiExternalLinkLine width={18} height={18} fill={colors.icon} />}
            title={t('skills.viewSource')}
            description={`${skill.sourceRepo ?? ''}${
              version?.sourceCommit
                ? ` · ${version.sourceCommit.slice(0, 7)}`
                : ''
            }`}
            accessibilityRole="link"
            onPress={() => void Linking.openURL(skill.sourceUrl!)}
          />
        </SettingsListGroup>
      ) : null}
    </ScrollView>
  );
}

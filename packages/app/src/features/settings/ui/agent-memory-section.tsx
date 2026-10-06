import {
  useAgentMemoryDocument,
  useAgentMemoryFiles,
  useAgentMemoryMutations,
  useRememberingAgents,
  type AgentMemoryFile,
} from '@/features/memory/runtime/use-agent-memory';
import { errorStatus } from '@/shared/api/error-utils';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { SettingsCard, SettingsRow, SettingsSection } from '@oxy.so/bloom/settings-modal';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { confirm } from '@oxy.so/bloom/surfaces';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useAliaSettings } from './settings-context';

/** This page's own strings. */
const K = 'settings.assistant.agentMemory';

/** The files an agent keeps, the index first. */
function sortFiles(files: AgentMemoryFile[]): AgentMemoryFile[] {
  return [...files].sort((a, b) => (a.path === 'MEMORY.md' ? -1 : b.path === 'MEMORY.md' ? 1 : a.path.localeCompare(b.path)));
}

/**
 * The agents that remember something about the person — a section of the
 * memory page, under Alia's own memory. Each one opens what it remembers.
 */
export function RememberingAgentsSection() {
  const { t } = useTranslation();
  const settings = useAliaSettings();
  const { data: agents, isPending } = useRememberingAgents();

  return (
    <SettingsSection label={t(`${K}.agentsTitle`)}>
      <SettingsCard>
        {isPending ? (
          <SettingsRow label={t('common.loading')}>
            <Skeleton.Box width={120} height={28} borderRadius={10} />
          </SettingsRow>
        ) : !agents?.length ? (
          <SettingsRow label={t(`${K}.agentsEmpty`)} description={t(`${K}.agentsEmptyDescription`)} />
        ) : (
          agents.map((agent) => (
            <SettingsRow
              key={agent.agentId}
              label={agent.name ?? (agent.handle ? `@${agent.handle}` : t(`${K}.unnamedAgent`))}
              description={t(`${K}.fileCount`, { count: agent.files })}
            >
              <Button
                size="sm"
                appearance="outline"
                tone="neutral"
                onPress={() => settings.open('agent-memory', {
                  agentId: agent.agentId,
                  name: agent.name ?? agent.handle ?? '',
                })}
              >
                {t(`${K}.open`)}
              </Button>
            </SettingsRow>
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

/** One file: read, edit in place, save with the hash it was read at, or forget. */
function MemoryFileEditor({ agentId, path, onForget }: { agentId: string; path: string; onForget: (path: string) => void }) {
  const { t } = useTranslation();
  const { data: document, isPending, refetch } = useAgentMemoryDocument(agentId, path);
  const { save } = useAgentMemoryMutations(agentId);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    if (document) setDraft(document.content);
  }, [document]);

  const dirty = document !== undefined && draft !== document.content;

  const handleSave = async () => {
    if (!document) return;
    try {
      await save.mutateAsync({ path, content: draft, expectedHash: document.hash });
      await refetch();
      toast.success(t('settings.saveSuccess'));
    } catch (error) {
      // 409: the agent wrote to it meanwhile. Show what it holds now.
      if (errorStatus(error) === 409) {
        await refetch();
        toast.error(t(`${K}.changedMeanwhile`));
        return;
      }
      toast.error(t('settings.saveFailed'));
    }
  };

  return (
    <SettingsSection label={path}>
      <SettingsCard>
        {isPending ? (
          <SettingsRow label={t('common.loading')}>
            <Skeleton.Box width={160} height={28} borderRadius={10} />
          </SettingsRow>
        ) : (
          <View className="gap-3 p-3">
            <Textarea
              accessibilityLabel={path}
              value={draft}
              onChangeText={setDraft}
              autoResize
              rows={4}
              maxRows={14}
            />
            <View className="flex-row justify-end">
              <ButtonGroup size="sm" accessibilityLabel={path}>
                <ButtonGroupItem onPress={handleSave} disabled={!dirty || save.isPending}>
                  {t('settings.saveButton')}
                </ButtonGroupItem>
                <ButtonGroupItem
                  iconOnly
                  leadingIcon={RiDeleteBinLine}
                  accessibilityLabel={`${t(`${K}.forget`)} ${path}`}
                  onPress={() => onForget(path)}
                />
              </ButtonGroup>
            </View>
          </View>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

/**
 * What one agent remembers about the person — its own files, not Alia's
 * memory. Editable, and forgettable one file at a time or all at once.
 */
export function AgentMemorySection() {
  const { t } = useTranslation();
  const settings = useAliaSettings();
  const agentId = settings.params.agentId ?? '';
  const name = settings.params.name || t(`${K}.unnamedAgent`);
  const { data: files, isPending } = useAgentMemoryFiles(agentId);
  const { forget } = useAgentMemoryMutations(agentId);

  const goBack = () => settings.open('memory');

  const handleForget = async (path?: string) => {
    const ok = await confirm({
      title: path === undefined ? t(`${K}.forgetAllTitle`, { name }) : t(`${K}.forgetFileTitle`, { path }),
      description: t(`${K}.forgetDescription`, { name }),
      confirmLabel: t(`${K}.forget`),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await forget.mutateAsync(path);
      toast.success(t(`${K}.forgotten`));
      if (path === undefined) goBack();
    } catch {
      toast.error(t(`${K}.forgetFailed`));
    }
  };

  return (
    <View className="w-full gap-6">
      <SettingsCard>
        <SettingsRow label={name} description={t(`${K}.description`, { name })}>
          <Button size="sm" appearance="outline" tone="neutral" leadingIcon={RiArrowLeftLine} onPress={goBack}>
            {t(`${K}.back`)}
          </Button>
        </SettingsRow>
      </SettingsCard>

      {isPending ? (
        <SettingsCard>
          <SettingsRow label={t('common.loading')}>
            <Skeleton.Box width={160} height={28} borderRadius={10} />
          </SettingsRow>
        </SettingsCard>
      ) : !files?.length ? (
        <SettingsCard>
          <SettingsRow label={t(`${K}.empty`, { name })} />
        </SettingsCard>
      ) : (
        <>
          {sortFiles(files).map((file) => (
            <MemoryFileEditor key={file.path} agentId={agentId} path={file.path} onForget={handleForget} />
          ))}
          <SettingsCard>
            <SettingsRow label={t(`${K}.forgetAllTitle`, { name })} description={t(`${K}.forgetAllDescription`)}>
              <Button size="sm" appearance="outline" tone="danger" leadingIcon={RiDeleteBinLine} onPress={() => handleForget()}>
                {t(`${K}.forgetAll`)}
              </Button>
            </SettingsRow>
          </SettingsCard>
        </>
      )}
    </View>
  );
}

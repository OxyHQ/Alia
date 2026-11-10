import {
  useAgentMemoryDocument,
  useAgentMemoryFiles,
  useAgentMemoryMutations,
  type AgentMemoryFile,
} from '@/features/agents/runtime/use-agent-memory';
import { errorStatus } from '@/shared/api/error-utils';
import { useTranslation } from '@/shared/i18n/use-translation';
import { SettingsSkeletonRows } from '@/shared/ui/skeletons';
import { AgentCreatorField, AgentCreatorSection } from '@oxy.so/bloom/agent-creator';
import { Button } from '@oxy.so/bloom/button';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { confirm } from '@oxy.so/bloom/surfaces';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

/** This section's own strings. */
const K = 'agents.editor.memory';

/** The files an agent keeps, the index first. */
function sortFiles(files: AgentMemoryFile[]): AgentMemoryFile[] {
  return [...files].sort((a, b) =>
    a.path === 'MEMORY.md' ? -1 : b.path === 'MEMORY.md' ? 1 : a.path.localeCompare(b.path),
  );
}

/** One file: read, edit in place, save with the hash it was read at, or forget. */
function MemoryFileRow({
  agentId,
  path,
  divider,
  onForget,
}: {
  agentId: string;
  path: string;
  divider: boolean;
  onForget: (path: string) => void;
}) {
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
    <AgentCreatorField label={path} multiline divider={divider}>
      {isPending ? (
        <SettingsSkeletonRows control="none" rows={2} />
      ) : (
        <View className="gap-2">
          <Textarea
            accessibilityLabel={path}
            size="sm"
            value={draft}
            onChangeText={setDraft}
            autoResize
            rows={3}
            maxRows={12}
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
    </AgentCreatorField>
  );
}

/**
 * What the agent remembers about the person: its own files, not Alia's memory. Editable, and
 * forgettable one file at a time or all at once.
 */
export function AgentMemorySection({ agentId, name }: { agentId: string; name: string }) {
  const { t } = useTranslation();
  const { data: files, isPending } = useAgentMemoryFiles(agentId);
  const { forget } = useAgentMemoryMutations(agentId);

  const handleForget = async (path?: string) => {
    const ok = await confirm({
      title:
        path === undefined
          ? t(`${K}.forgetAllTitle`, { name })
          : t(`${K}.forgetFileTitle`, { path }),
      description: t(`${K}.forgetDescription`, { name }),
      confirmLabel: t(`${K}.forget`),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await forget.mutateAsync(path);
      toast.success(t(`${K}.forgotten`));
    } catch {
      toast.error(t(`${K}.forgetFailed`));
    }
  };

  return (
    <AgentCreatorSection title={t(`${K}.title`)}>
      {isPending ? (
        <SettingsSkeletonRows control="none" rows={2} />
      ) : !files?.length ? (
        <AgentCreatorField label={t(`${K}.title`)} divider={false}>
          <Text variant="body-2-regular">{t(`${K}.empty`, { name })}</Text>
        </AgentCreatorField>
      ) : (
        <>
          {sortFiles(files).map((file, index) => (
            <MemoryFileRow
              key={file.path}
              agentId={agentId}
              path={file.path}
              divider={index > 0}
              onForget={handleForget}
            />
          ))}
          <AgentCreatorField label={t(`${K}.forgetAll`)}>
            <Button
              size="sm"
              appearance="outline"
              tone="danger"
              leadingIcon={RiDeleteBinLine}
              onPress={() => handleForget()}
            >
              {t(`${K}.forgetAllTitle`, { name })}
            </Button>
          </AgentCreatorField>
        </>
      )}
    </AgentCreatorSection>
  );
}

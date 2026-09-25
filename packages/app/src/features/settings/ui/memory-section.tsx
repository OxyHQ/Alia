import { generateAPIUrl } from '@/shared/api/generate-api-url';
import { useTranslation } from '@/shared/i18n/use-translation';
import { useUserData } from '@/features/memory/runtime/use-user-data';
import { useComposerDraftStore } from '@/features/chat/runtime/composer-draft-store';
import { useUserDataStore } from '@/features/memory/runtime/user-data-store';
import { Button } from '@oxy.so/bloom/button';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { Dialog, type DialogAction } from '@oxy.so/bloom/dialog';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiDownload2Line } from '@oxy.so/bloom/icons/RiDownload2Line';
import { RiFileCopyLine } from '@oxy.so/bloom/icons/RiFileCopyLine';
import { RiUpload2Line } from '@oxy.so/bloom/icons/RiUpload2Line';
import { Search } from '@oxy.so/bloom/search';
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsValueField,
} from '@oxy.so/bloom/settings-modal';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { confirm } from '@oxy.so/bloom/surfaces';
import { Switch } from '@oxy.so/bloom/switch';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth, useOxy } from '@oxy.so/services';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SettingsPreferenceSelect } from './preference-select';

/** This page's own strings. */
const K = 'settings.assistant.memory';

type MemoryType = 'profile' | 'topic' | 'person';

interface Memory {
  _id: string;
  title: string;
  summary: string;
  type: MemoryType;
  createdAt: string;
  updatedAt: string;
}

/** Aggregate counts returned by the export-preview endpoint. */
interface ExportStats {
  totalMemories: number;
  totalTypes: number;
  estimatedSizeJSON: number;
}

/** Summary returned by the import-validate endpoint before committing an import. */
interface ImportPreview {
  totalToImport: number;
  newTitles: number;
  duplicateTitles: number;
  estimatedFinalTotal: number;
  memoryLimit: number;
}

/** A pair of memories flagged as duplicates by the dedupe endpoint. */
interface DuplicatePair {
  reason: string;
  memory1?: { _id: string; title: string; summary: string };
  memory2?: { _id: string; title: string; summary: string };
}

const TYPE_SECTIONS: {
  type: MemoryType;
  headingKey: string;
  emptyKey: string;
}[] = [
  {
    type: 'profile',
    headingKey: 'memory.sectionYou',
    emptyKey: 'memory.sectionYouEmpty',
  },
  {
    type: 'topic',
    headingKey: 'memory.sectionTopics',
    emptyKey: 'memory.sectionTopicsEmpty',
  },
  {
    type: 'person',
    headingKey: 'memory.sectionPeople',
    emptyKey: 'memory.sectionPeopleEmpty',
  },
];

export function MemorySection() {
  const { isAuthenticated, oxyServices } = useOxy();
  const { signIn } = useAuth();
  const { memory, loading } = useUserData();
  const setMemory = useUserDataStore((state) => state.setMemory);
  const { t } = useTranslation();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');

  // Settings toggles
  const [updatingSettings, setUpdatingSettings] = useState(false);

  // Export/Import state
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [exportFormat, setExportFormat] = useState<'json' | 'csv'>('json');
  const [exportStats, setExportStats] = useState<ExportStats | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importStrategy, setImportStrategy] = useState<
    'merge' | 'replace' | 'skip-duplicates'
  >('merge');
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(
    null,
  );
  const [importing, setImporting] = useState(false);

  // Duplicate detection state
  const [showDuplicatesDialog, setShowDuplicatesDialog] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicatePair[]>([]);
  const [duplicatesLoading, setDuplicatesLoading] = useState(false);

  // Import-from-provider state
  const [showProviderImportDialog, setShowProviderImportDialog] =
    useState(false);
  const [providerImportStep, setProviderImportStep] = useState<
    'prompt' | 'paste'
  >('prompt');
  const [providerPastedText, setProviderPastedText] = useState('');
  const [providerImporting, setProviderImporting] = useState(false);
  const [providerImportResult, setProviderImportResult] = useState<
    { title: string; summary: string; type: string }[] | null
  >(null);

  const PROVIDER_IMPORT_PROMPT =
    "Please summarize everything you remember or know about me as a numbered list of short facts. For each fact, keep it to one or two sentences. Include preferences, personal details, ongoing projects or topics I care about, and people I've mentioned. Don't add commentary — just the list.";

  const memories = memory?.memories || [];

  // Redirect if not authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      signIn().catch(() => {});
    }
  }, [isAuthenticated, signIn]);

  // Filter memories by search query
  const filteredMemories = useMemo(() => {
    if (!searchQuery.trim()) return memories;
    const query = searchQuery.toLowerCase();
    return memories.filter(
      (m) =>
        m.title.toLowerCase().includes(query) ||
        m.summary.toLowerCase().includes(query),
    );
  }, [memories, searchQuery]);

  /**
   * Memories are written by talking to Alia, not by filling in a form: hand the
   * new-chat composer a half-written instruction and let the user finish it.
   * The model applies it through its own `saveUserMemory` tool.
   */
  const startMemoryChat = (draft: string) => {
    const drafts = useComposerDraftStore.getState();
    drafts.restore(drafts.address(null), {
      text: draft,
      mcpServerId: null,
      skillNames: [],
    });
    router.replace('/(app)');
  };

  const getAuthHeaders = (contentType?: boolean): Record<string, string> => {
    const headers: Record<string, string> = {};
    const token = oxyServices.getAccessToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (contentType) headers['Content-Type'] = 'application/json';
    return headers;
  };

  const handleDeleteMemory = async (memoryId: string) => {
    if (!isAuthenticated) return;

    const ok = await confirm({
      title: t('memory.deleteMemory'),
      description: t('memory.deleteConfirmation'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;

    try {
      const apiUrl = generateAPIUrl(`/memory/${memoryId}`);
      const response = await fetch(apiUrl, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });

      if (response.ok) {
        const updatedMemory = await response.json();
        setMemory(updatedMemory);
        toast.success(t('memory.memoryDeleted'));
      }
    } catch (error) {
      console.error('Error deleting memory:', error);
      toast.error(t('memory.failedToDelete'));
    }
  };

  const handleToggleSetting = async (
    key: 'autoSaveEnabled' | 'recallEnabled',
    value: boolean,
  ) => {
    if (!isAuthenticated || !memory) return;

    setUpdatingSettings(true);
    try {
      const apiUrl = generateAPIUrl('/memory/settings');
      const response = await fetch(apiUrl, {
        method: 'PUT',
        headers: getAuthHeaders(true),
        body: JSON.stringify({ [key]: value }),
      });

      if (response.ok) {
        const settings = await response.json();
        setMemory({ ...memory, settings });
      } else {
        toast.error(t('memory.failedToSaveSettings'));
      }
    } catch (error) {
      console.error('Error updating memory settings:', error);
      toast.error(t('memory.failedToSaveSettings'));
    } finally {
      setUpdatingSettings(false);
    }
  };

  // Duplicate detection handler
  const loadDuplicates = async () => {
    if (!isAuthenticated) return;

    setDuplicatesLoading(true);
    try {
      const apiUrl = generateAPIUrl('/memory/duplicates');
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: getAuthHeaders(),
      });

      if (response.ok) {
        const data = await response.json();
        setDuplicates(data.duplicates || []);
        setShowDuplicatesDialog(true);
      } else {
        toast.error(t('memory.failedDuplicates'));
      }
    } catch (error) {
      console.error('Duplicates error:', error);
      toast.error(t('memory.failedDuplicates'));
    } finally {
      setDuplicatesLoading(false);
    }
  };

  const groupedByType = useMemo(() => {
    return {
      profile: filteredMemories.filter((m) => m.type === 'profile'),
      topic: filteredMemories.filter((m) => m.type === 'topic'),
      person: filteredMemories.filter((m) => m.type === 'person'),
    };
  }, [filteredMemories]);

  // Export handlers
  const loadExportStats = async () => {
    if (!isAuthenticated) return;

    try {
      const apiUrl = generateAPIUrl('/memory/export/preview');
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: getAuthHeaders(),
      });

      if (response.ok) {
        const stats = await response.json();
        setExportStats(stats);
      }
    } catch (error) {
      console.error('Export stats error:', error);
      toast.error(t('memory.failedToLoadStats'));
    }
  };

  const handleExport = async (format: 'json' | 'csv') => {
    if (!isAuthenticated) return;

    try {
      const apiUrl = generateAPIUrl(`/memory/export/${format}`);
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: getAuthHeaders(),
      });

      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `alia-memories-${Date.now()}.${format}`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

        toast.success(t('memory.exportedAs', { format: format.toUpperCase() }));
        setShowExportDialog(false);
      } else {
        const error = await response.json();
        toast.error(error.error || t('memory.exportFailed'));
      }
    } catch (error) {
      console.error('Export error:', error);
      toast.error(t('memory.failedToExport'));
    }
  };

  // Import handlers
  const handleFileSelect = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      toast.error(t('memory.fileTooLarge'));
      return;
    }

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      const response = await fetch(generateAPIUrl('/memory/import/validate'), {
        method: 'POST',
        headers: getAuthHeaders(true),
        body: JSON.stringify({ data }),
      });

      const result = await response.json();

      if (result.valid) {
        setImportFile(file);
        setImportPreview(result.analysis);
      } else {
        toast.error(t('memory.invalidFileFormat'));
        console.error('Validation errors:', result.errors);
      }
    } catch (error) {
      toast.error(t('memory.failedToReadFile'));
      console.error(error);
    }
  };

  const handleImport = async () => {
    if (!importFile || !isAuthenticated) return;

    setImporting(true);
    try {
      const text = await importFile.text();
      const data = JSON.parse(text);

      const response = await fetch(generateAPIUrl('/memory/import'), {
        method: 'POST',
        headers: getAuthHeaders(true),
        body: JSON.stringify({ data, strategy: importStrategy }),
      });

      if (response.ok) {
        const result = await response.json();

        const memResponse = await fetch(generateAPIUrl('/memory'), {
          headers: getAuthHeaders(),
        });
        if (memResponse.ok) {
          setMemory(await memResponse.json());
        }

        toast.success(
          t('memory.importSuccess', {
            imported: result.stats.imported,
            updated: result.stats.updated,
            skipped: result.stats.skipped,
          }),
        );

        setShowImportDialog(false);
        setImportFile(null);
        setImportPreview(null);
      } else {
        const error = await response.json();
        toast.error(error.error || t('memory.importFailed'));
      }
    } catch (error) {
      console.error('Import error:', error);
      toast.error(t('memory.failedToImport'));
    } finally {
      setImporting(false);
    }
  };

  const handleProviderImport = async () => {
    if (!providerPastedText.trim() || !isAuthenticated) return;

    setProviderImporting(true);
    try {
      const response = await fetch(generateAPIUrl('/memory/import/from-text'), {
        method: 'POST',
        headers: getAuthHeaders(true),
        body: JSON.stringify({ text: providerPastedText }),
      });

      if (response.ok) {
        const result = await response.json();
        setProviderImportResult(result.saved || []);

        const memResponse = await fetch(generateAPIUrl('/memory'), {
          headers: getAuthHeaders(),
        });
        if (memResponse.ok) {
          setMemory(await memResponse.json());
        }

        toast.success(
          t('memory.providerImportSuccess', {
            count: (result.saved || []).length,
          }),
        );
      } else {
        toast.error(t('memory.providerImportFailed'));
      }
    } catch (error) {
      console.error('Provider import error:', error);
      toast.error(t('memory.providerImportFailed'));
    } finally {
      setProviderImporting(false);
    }
  };

  const handleCloseProviderImport = () => {
    setShowProviderImportDialog(false);
    setProviderImportStep('prompt');
    setProviderPastedText('');
    setProviderImportResult(null);
  };

  if (loading) {
    // The page's own geometry, shimmering: the settings card, then a list.
    return (
      <View className="flex-1 gap-6">
        <Skeleton.Box width="100%" height={156} borderRadius={16} />
        <Skeleton.Box width="100%" height={208} borderRadius={16} />
        <Skeleton.Box width="100%" height={156} borderRadius={16} />
      </View>
    );
  }

  // The provider import is a two-step wizard, so its action row is computed
  // rather than declared inline.
  const providerImportActions: DialogAction[] =
    providerImportStep === 'prompt'
      ? [
          {
            label: t('memory.nextStep'),
            onPress: () => setProviderImportStep('paste'),
            shouldCloseOnPress: false,
          },
        ]
      : [
          {
            label: providerImportResult ? t('common.done') : t('common.cancel'),
            color: 'cancel',
            disabled: providerImporting,
          },
          ...(providerImportResult
            ? []
            : [
                {
                  label: providerImporting
                    ? t('memory.importing')
                    : t('memory.import'),
                  onPress: handleProviderImport,
                  disabled: !providerPastedText.trim() || providerImporting,
                  // The import is in flight when this runs and the label reports it.
                  shouldCloseOnPress: false,
                } satisfies DialogAction,
              ]),
        ];

  const editMemory = (found: Memory) =>
    startMemoryChat(
      t('memory.chatEditPrompt', {
        title: found.title,
        summary: found.summary,
      }),
    );

  return (
    <>
      {/* SettingsGeneralPage's page geometry (full width, sections 24 apart),
          spelled out because the search field is a section, not a row. */}
      <View className="w-full gap-6">
        <SettingsCard>
          <SettingsRow
            label={t('memory.recallToggleLabel')}
            description={t('memory.recallToggleDescription')}
          >
            <Switch
              accessibilityLabel={t('memory.recallToggleLabel')}
              checked={memory?.settings?.recallEnabled ?? true}
              onCheckedChange={(v) => handleToggleSetting('recallEnabled', v)}
              disabled={updatingSettings}
            />
          </SettingsRow>
          <SettingsRow
            label={t('memory.autoSaveToggleLabel')}
            description={t('memory.autoSaveToggleDescription')}
          >
            <Switch
              accessibilityLabel={t('memory.autoSaveToggleLabel')}
              checked={memory?.settings?.autoSaveEnabled ?? true}
              onCheckedChange={(v) => handleToggleSetting('autoSaveEnabled', v)}
              disabled={updatingSettings}
            />
          </SettingsRow>
        </SettingsCard>

        <SettingsSection label={t(`${K}.manage`)}>
          <SettingsCard>
            <SettingsRow
              label={t('memory.newMemory')}
              description={t(`${K}.newMemoryDescription`)}
            >
              <Button
                size="sm"
                appearance="outline"
                tone="neutral"
                leadingIcon={RiAddLine}
                onPress={() => startMemoryChat(t('memory.chatAddPrompt'))}
              >
                {t('memory.addMemory')}
              </Button>
            </SettingsRow>
            <SettingsRow
              label={t('memory.importFromProvider')}
              description={t('memory.providerImportRowDescription')}
            >
              <Button
                size="sm"
                appearance="outline"
                tone="neutral"
                onPress={() => setShowProviderImportDialog(true)}
              >
                {t('memory.startImport')}
              </Button>
            </SettingsRow>
            <SettingsRow
              label={t('memory.exportTitle')}
              description={t('memory.exportDescription')}
            >
              <Button
                size="sm"
                appearance="outline"
                tone="neutral"
                leadingIcon={RiDownload2Line}
                onPress={() => {
                  setShowExportDialog(true);
                  loadExportStats();
                }}
              >
                {t('memory.export')}
              </Button>
            </SettingsRow>
            <SettingsRow
              label={t('memory.importTitle')}
              description={t('memory.importDescription')}
            >
              <Button
                size="sm"
                appearance="outline"
                tone="neutral"
                leadingIcon={RiUpload2Line}
                onPress={() => setShowImportDialog(true)}
              >
                {t('memory.import')}
              </Button>
            </SettingsRow>
            <SettingsRow
              label={t('memory.duplicateMemories')}
              description={t(`${K}.duplicatesDescription`)}
            >
              <Button
                size="sm"
                appearance="outline"
                tone="neutral"
                leadingIcon={RiFileCopyLine}
                onPress={loadDuplicates}
                disabled={duplicatesLoading}
              >
                {t(`${K}.findDuplicates`)}
              </Button>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection
          label={t(`${K}.count`, { count: filteredMemories.length })}
        >
          <Search
            label={t('memory.searchPlaceholder')}
            value={searchQuery}
            onChangeText={setSearchQuery}
            onClearText={() => setSearchQuery('')}
          />
        </SettingsSection>

        {memories.length === 0 ? (
          <SettingsCard>
            <SettingsRow
              label={t('memory.noMemories')}
              description={t('memory.shareInfo')}
            />
          </SettingsCard>
        ) : (
          TYPE_SECTIONS.map((section) => {
            const rows = groupedByType[section.type];
            return (
              <SettingsSection key={section.type} label={t(section.headingKey)}>
                <SettingsCard>
                  {rows.length ? (
                    rows.map((row) => (
                      <SettingsRow
                        key={row._id}
                        label={row.title}
                        description={row.summary}
                      >
                        <ButtonGroup
                          size="sm"
                          accessibilityLabel={row.title}
                        >
                          <ButtonGroupItem onPress={() => editMemory(row)}>
                            {t('common.edit')}
                          </ButtonGroupItem>
                          <ButtonGroupItem
                            iconOnly
                            leadingIcon={RiDeleteBinLine}
                            accessibilityLabel={`${t('common.delete')} ${row.title}`}
                            onPress={() => handleDeleteMemory(row._id)}
                          />
                        </ButtonGroup>
                      </SettingsRow>
                    ))
                  ) : (
                    <SettingsRow
                      label={t(section.emptyKey)}
                      description={
                        searchQuery.trim()
                          ? t('common.tryDifferentSearch')
                          : undefined
                      }
                    />
                  )}
                </SettingsCard>
              </SettingsSection>
            );
          })
        )}
      </View>

      {/* Export Dialog */}
      <Dialog
        open={showExportDialog}
        onClose={() => setShowExportDialog(false)}
        placement={{ base: 'bottom', md: 'center' }}
        title={t('memory.exportTitle')}
        description={t('memory.exportDescription')}
        actions={[
          { label: t('common.cancel'), color: 'cancel' },
          {
            label: t('memory.download', { format: exportFormat.toUpperCase() }),
            onPress: () => handleExport(exportFormat),
          },
        ]}
      >
        {exportStats && (
          <View className="gap-4">
            <SettingsSection label={t('memory.exportStatistics')}>
              <SettingsCard>
                <SettingsRow label={t('memory.totalMemories')}>
                  <SettingsValueField>
                    {exportStats.totalMemories}
                  </SettingsValueField>
                </SettingsRow>
                <SettingsRow label={t('memory.types')}>
                  <SettingsValueField>{exportStats.totalTypes}</SettingsValueField>
                </SettingsRow>
                <SettingsRow label={t('memory.sizeJSON')}>
                  <SettingsValueField>
                    {t('memory.sizeKb', {
                      size: (exportStats.estimatedSizeJSON / 1024).toFixed(1),
                    })}
                  </SettingsValueField>
                </SettingsRow>
              </SettingsCard>
            </SettingsSection>
            <SettingsCard>
              <SettingsRow
                label={t('memory.format')}
                description={
                  exportFormat === 'json'
                    ? t('memory.jsonDescription')
                    : t('memory.csvDescription')
                }
              >
                <SettingsPreferenceSelect
                  label={t('memory.format')}
                  value={exportFormat}
                  onChange={setExportFormat}
                  items={[
                    { value: 'json', label: t('memory.jsonFull') },
                    { value: 'csv', label: t('memory.csv') },
                  ]}
                />
              </SettingsRow>
            </SettingsCard>
          </View>
        )}
      </Dialog>

      {/* Import Dialog (file-based) */}
      <Dialog
        open={showImportDialog}
        onClose={() => setShowImportDialog(false)}
        placement={{ base: 'bottom', md: 'center' }}
        title={t('memory.importTitle')}
        description={t('memory.importDescription')}
        actions={[
          { label: t('common.cancel'), color: 'cancel', disabled: importing },
          {
            label: importing ? t('memory.importing') : t('memory.import'),
            onPress: handleImport,
            disabled: !importFile || importing,
            // The import is in flight when this runs and the label reports it.
            shouldCloseOnPress: false,
          },
        ]}
      >
        <View className="gap-4">
          <SettingsCard>
            <SettingsRow label={t('memory.selectFile')}>
              {/* Web-only file chooser: Bloom has no bare file-picker control. */}
              <input type="file" accept=".json" onChange={handleFileSelect} />
            </SettingsRow>
          </SettingsCard>

          {importPreview && (
            <SettingsSection label={t('memory.preview')}>
              <SettingsCard>
                <SettingsRow label={t('memory.totalToImport')}>
                  <SettingsValueField>
                    {importPreview.totalToImport}
                  </SettingsValueField>
                </SettingsRow>
                <SettingsRow label={t('memory.newMemoriesCount')}>
                  <SettingsValueField>{importPreview.newTitles}</SettingsValueField>
                </SettingsRow>
                <SettingsRow label={t('memory.duplicatesCount')}>
                  <SettingsValueField>
                    {importPreview.duplicateTitles}
                  </SettingsValueField>
                </SettingsRow>
                <SettingsRow label={t('memory.finalTotal')}>
                  <SettingsValueField>
                    {importPreview.estimatedFinalTotal}
                  </SettingsValueField>
                </SettingsRow>
                {importPreview.memoryLimit !== -1 && (
                  <SettingsRow label={t('memory.memoryLimit')}>
                    <SettingsValueField>
                      {importPreview.memoryLimit}
                    </SettingsValueField>
                  </SettingsRow>
                )}
              </SettingsCard>
            </SettingsSection>
          )}

          {importFile && (
            <SettingsCard>
              <SettingsRow
                label={t('memory.importStrategy')}
                description={
                  importStrategy === 'merge'
                    ? t('memory.mergeDescription')
                    : importStrategy === 'skip-duplicates'
                      ? t('memory.skipDescription')
                      : t('memory.replaceDescription')
                }
              >
                <SettingsPreferenceSelect
                  label={t('memory.importStrategy')}
                  value={importStrategy}
                  onChange={setImportStrategy}
                  items={[
                    { value: 'merge', label: t('memory.merge') },
                    { value: 'skip-duplicates', label: t('memory.skipDupes') },
                    { value: 'replace', label: t('memory.replaceAll') },
                  ]}
                />
              </SettingsRow>
            </SettingsCard>
          )}
        </View>
      </Dialog>

      {/* Duplicates Dialog */}
      <Dialog
        open={showDuplicatesDialog}
        onClose={() => setShowDuplicatesDialog(false)}
        placement={{ base: 'bottom', md: 'center' }}
        title={t('memory.duplicateMemories')}
        actions={[{ label: t('common.done'), color: 'cancel' }]}
        description={
          duplicates.length === 0
            ? t('memory.noDuplicates')
            : t('memory.foundDuplicates', { count: duplicates.length })
        }
      >
        {duplicates.length > 0 && (
          <ScrollView className="max-h-[400px]">
            <View className="gap-4">
              {duplicates.map((dup, i) => {
                // Keeping one of the pair deletes the other.
                const keep = (targetId?: string) => {
                  if (targetId) handleDeleteMemory(targetId);
                  setDuplicates((prev) => prev.filter((_, idx) => idx !== i));
                };
                return (
                  <SettingsSection
                    key={i}
                    label={
                      dup.reason === 'identical_summary'
                        ? t('memory.identicalValue')
                        : t('memory.similarKey')
                    }
                  >
                    <SettingsCard>
                      <SettingsRow
                        label={dup.memory1?.title ?? ''}
                        description={dup.memory1?.summary}
                      >
                        <Button
                          size="sm"
                          appearance="outline"
                          tone="neutral"
                          onPress={() => keep(dup.memory2?._id)}
                        >
                          {t('memory.keepFirst')}
                        </Button>
                      </SettingsRow>
                      <SettingsRow
                        label={dup.memory2?.title ?? ''}
                        description={dup.memory2?.summary}
                      >
                        <Button
                          size="sm"
                          appearance="outline"
                          tone="neutral"
                          onPress={() => keep(dup.memory1?._id)}
                        >
                          {t('memory.keepSecond')}
                        </Button>
                      </SettingsRow>
                    </SettingsCard>
                  </SettingsSection>
                );
              })}
            </View>
          </ScrollView>
        )}
      </Dialog>

      {/* Import from other AI provider */}
      <Dialog
        open={showProviderImportDialog}
        onClose={handleCloseProviderImport}
        placement={{ base: 'bottom', md: 'center' }}
        title={t('memory.importFromProvider')}
        actions={providerImportActions}
        description={
          providerImportStep === 'prompt'
            ? t('memory.providerImportStepPromptDescription')
            : t('memory.providerImportStepPasteDescription')
        }
      >
        {providerImportStep === 'prompt' ? (
          <SettingsCard>
            <SettingsRow label={PROVIDER_IMPORT_PROMPT}>
              <Button
                size="sm"
                appearance="outline"
                tone="neutral"
                leadingIcon={RiFileCopyLine}
                onPress={() => {
                  if (typeof navigator !== 'undefined' && navigator.clipboard) {
                    navigator.clipboard.writeText(PROVIDER_IMPORT_PROMPT);
                    toast.success(t('memory.promptCopied'));
                  }
                }}
              >
                {t('memory.copyPrompt')}
              </Button>
            </SettingsRow>
          </SettingsCard>
        ) : (
          <View className="gap-4">
            <Textarea
              label={t('memory.pasteResponseLabel')}
              value={providerPastedText}
              onChangeText={setProviderPastedText}
              placeholder={t('memory.pasteResponsePlaceholder')}
              editable={!providerImporting}
              autoResize
              rows={8}
            />

            {providerImportResult && (
              <SettingsSection label={t('memory.providerImportResultHeading')}>
                <SettingsCard>
                  {providerImportResult.length === 0 ? (
                    <SettingsRow label={t('memory.providerImportNoneFound')} />
                  ) : (
                    providerImportResult.map((m, i) => (
                      <SettingsRow
                        key={i}
                        label={m.title}
                        description={m.summary}
                      />
                    ))
                  )}
                </SettingsCard>
              </SettingsSection>
            )}
          </View>
        )}
      </Dialog>
    </>
  );
}

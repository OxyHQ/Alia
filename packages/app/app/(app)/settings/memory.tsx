import React, { useState, useEffect, useMemo } from 'react';
import { View, ScrollView } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, type DialogAction } from "@oxyhq/bloom/dialog";
import { confirm } from "@oxyhq/bloom/alert-dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useOxy, useAuth } from "@oxyhq/services";
import { useRouter } from "expo-router";
import { generateAPIUrl } from "@/lib/generate-api-url";
import {
  Brain,
  Plus,
  Download,
  Upload,
  FileJson,
  FileText,
  Copy,
} from "lucide-react-native";
import { Search } from "@oxyhq/bloom/search";
import { useTranslation } from "@/lib/hooks/use-translation";
import { useUserData } from "@/lib/hooks/use-user-data";
import { useUserDataStore } from "@/lib/stores/user-data-store";
import { useStore } from "@/lib/stores/global-store";
import { cn } from "@/lib/utils";
import { toast } from "@oxyhq/bloom/toast";
import { SettingsHeader } from "@/components/settings/settings-header";
import { MemoryTable } from "@/components/settings/memory-table";

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

const TYPE_SECTIONS: { type: MemoryType; headingKey: string; emptyKey: string }[] = [
  { type: 'profile', headingKey: 'memory.sectionYou', emptyKey: 'memory.sectionYouEmpty' },
  { type: 'topic', headingKey: 'memory.sectionTopics', emptyKey: 'memory.sectionTopicsEmpty' },
  { type: 'person', headingKey: 'memory.sectionPeople', emptyKey: 'memory.sectionPeopleEmpty' },
];

export default function MemoryScreen() {
  const { isAuthenticated, oxyServices } = useOxy();
  const { signIn } = useAuth();
  const { memory, loading } = useUserData();
  const setMemory = useUserDataStore((state) => state.setMemory);
  const { t } = useTranslation();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");

  // Settings toggles
  const [updatingSettings, setUpdatingSettings] = useState(false);

  // Export/Import state
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [exportFormat, setExportFormat] = useState<'json' | 'csv'>('json');
  const [exportStats, setExportStats] = useState<ExportStats | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importStrategy, setImportStrategy] = useState<'merge' | 'replace' | 'skip-duplicates'>('merge');
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importing, setImporting] = useState(false);

  // Duplicate detection state
  const [showDuplicatesDialog, setShowDuplicatesDialog] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicatePair[]>([]);
  const [duplicatesLoading, setDuplicatesLoading] = useState(false);

  // Import-from-provider state
  const [showProviderImportDialog, setShowProviderImportDialog] = useState(false);
  const [providerImportStep, setProviderImportStep] = useState<'prompt' | 'paste'>('prompt');
  const [providerPastedText, setProviderPastedText] = useState('');
  const [providerImporting, setProviderImporting] = useState(false);
  const [providerImportResult, setProviderImportResult] = useState<{ title: string; summary: string; type: string }[] | null>(null);

  const PROVIDER_IMPORT_PROMPT = "Please summarize everything you remember or know about me as a numbered list of short facts. For each fact, keep it to one or two sentences. Include preferences, personal details, ongoing projects or topics I care about, and people I've mentioned. Don't add commentary — just the list.";

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
    return memories.filter(m =>
      m.title.toLowerCase().includes(query) ||
      m.summary.toLowerCase().includes(query)
    );
  }, [memories, searchQuery]);

  /**
   * Memories are written by talking to Alia, not by filling in a form: hand the
   * new-chat composer a half-written instruction and let the user finish it.
   * The model applies it through its own `saveUserMemory` tool.
   */
  const startMemoryChat = (draft: string) => {
    useStore.getState().setComposerDraft({ text: draft, target: null });
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
      title: t("memory.deleteMemory"),
      description: t("memory.deleteConfirmation"),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
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
        toast.success(t("memory.memoryDeleted"));
      }
    } catch (error) {
      console.error("Error deleting memory:", error);
      toast.error(t("memory.failedToDelete"));
    }
  };

  const handleToggleSetting = async (key: 'autoSaveEnabled' | 'recallEnabled', value: boolean) => {
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
      console.error("Error updating memory settings:", error);
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
        toast.error(t("memory.failedDuplicates"));
      }
    } catch (error) {
      console.error("Duplicates error:", error);
      toast.error(t("memory.failedDuplicates"));
    } finally {
      setDuplicatesLoading(false);
    }
  };


  const groupedByType = useMemo(() => {
    return {
      profile: filteredMemories.filter(m => m.type === 'profile'),
      topic: filteredMemories.filter(m => m.type === 'topic'),
      person: filteredMemories.filter(m => m.type === 'person'),
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
  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
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
          })
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

        toast.success(t('memory.providerImportSuccess', { count: (result.saved || []).length }));
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
  return (
      <View className="flex-1 items-center justify-center bg-background">
        <Text>{t("common.loading")}</Text>
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
                  label: providerImporting ? t('memory.importing') : t('memory.import'),
                  onPress: handleProviderImport,
                  disabled: !providerPastedText.trim() || providerImporting,
                  // The import is in flight when this runs and the label reports it.
                  shouldCloseOnPress: false,
                } satisfies DialogAction,
              ]),
        ];

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("memory.title")} showBack />
      <ScrollView className="flex-1" contentContainerClassName="max-w-2xl">
        {/* Settings toggles */}
        <View className="px-4 pt-2 pb-1">
          <View className="flex-row items-center justify-between gap-4 py-3 border-b border-border">
            <View className="flex-1 min-w-0 gap-1">
              <Text className="text-sm text-foreground">{t('memory.recallToggleLabel')}</Text>
              <Text className="text-sm text-muted-foreground">{t('memory.recallToggleDescription')}</Text>
            </View>
            <Switch
              value={memory?.settings?.recallEnabled ?? true}
              onValueChange={(v) => handleToggleSetting('recallEnabled', v)}
              disabled={updatingSettings}
            />
          </View>
          <View className="flex-row items-center justify-between gap-4 py-3 border-b border-border">
            <View className="flex-1 min-w-0 gap-1">
              <Text className="text-sm text-foreground">{t('memory.autoSaveToggleLabel')}</Text>
              <Text className="text-sm text-muted-foreground">{t('memory.autoSaveToggleDescription')}</Text>
            </View>
            <Switch
              value={memory?.settings?.autoSaveEnabled ?? true}
              onValueChange={(v) => handleToggleSetting('autoSaveEnabled', v)}
              disabled={updatingSettings}
            />
          </View>
          <View className="flex-row items-center justify-between gap-4 py-3">
            <View className="flex-1 min-w-0 gap-1">
              <Text className="text-sm text-foreground">{t('memory.importFromProvider')}</Text>
              <Text className="text-sm text-muted-foreground">{t('memory.providerImportRowDescription')}</Text>
            </View>
            <Button
              variant="secondary"
              size="sm"
              onPress={() => setShowProviderImportDialog(true)}
            >
              <Text className="text-sm">{t('memory.startImport')}</Text>
            </Button>
          </View>
        </View>

        {/* Compact Toolbar */}
        <View className="px-4 pt-1 pb-2 gap-2">
          <View className="flex-row items-center gap-2">
            <View className="flex-1">
              <Search
                label={t("memory.searchPlaceholder")}
                value={searchQuery}
                onChangeText={setSearchQuery}
                onClearText={() => setSearchQuery("")}
              />
            </View>

            <Button
              onPress={() => startMemoryChat(t('memory.chatAddPrompt'))}
              size="sm"
              className="h-11 px-3 rounded-lg"
              accessibilityLabel={t('memory.newMemory')}
            >
              <View className="flex-row items-center gap-1.5">
                <Plus size={16} className="text-primary-foreground" />
              </View>
            </Button>
          </View>

          <View className="flex-row items-center justify-between">
            <Text className="text-xs text-muted-foreground">
              {filteredMemories.length} {filteredMemories.length === 1 ? 'memoria' : 'memorias'}
            </Text>
            <View className="flex-row items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onPress={() => {
                  setShowExportDialog(true);
                  loadExportStats();
                }}
              >
                <Download size={14} className="text-muted-foreground" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onPress={() => setShowImportDialog(true)}
              >
                <Upload size={14} className="text-muted-foreground" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onPress={loadDuplicates}
                disabled={duplicatesLoading}
              >
                <Copy size={14} className="text-muted-foreground" />
              </Button>
            </View>
          </View>
        </View>

        {/* Grouped sections */}
        <View className="px-4 pb-4">
          {memories.length === 0 ? (
            <View className="items-center justify-center py-12">
              <Brain size={32} className="text-muted-foreground opacity-40" />
              <Text className="text-sm font-medium text-muted-foreground mt-3">
                {t('memory.noMemories')}
              </Text>
              <Text className="text-xs text-muted-foreground text-center mt-1 max-w-xs">
                {t('memory.shareInfo')}
              </Text>
            </View>
          ) : (
            <>
              {TYPE_SECTIONS.map((section) => (
                <MemoryTable
                  key={section.type}
                  heading={t(section.headingKey)}
                  rows={groupedByType[section.type]}
                  emptyLabel={t(section.emptyKey)}
                  onRowPress={(id) => {
                    const found = memories.find(m => m._id === id);
                    if (found) {
                      startMemoryChat(t('memory.chatEditPrompt', { title: found.title, summary: found.summary }));
                    }
                  }}
                  onDelete={handleDeleteMemory}
                />
              ))}
            </>
          )}
        </View>
      </ScrollView>

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
            <View className="gap-3">
              <View className="bg-muted rounded-lg p-3">
                <Text className="text-sm text-muted-foreground mb-2">{t('memory.exportStatistics')}</Text>
                <Text className="text-sm">{t('memory.totalMemories')}: {exportStats.totalMemories}</Text>
                <Text className="text-sm">{t('memory.types')}: {exportStats.totalTypes}</Text>
                <Text className="text-sm">
                  {t('memory.sizeJSON')}: ~{(exportStats.estimatedSizeJSON / 1024).toFixed(1)} KB
                </Text>
              </View>

              <View className="gap-2">
                <Label>{t('memory.format')}</Label>
                <ToggleGroup
                  type="single"
                  value={exportFormat}
                  onValueChange={(val) => setExportFormat(val as 'json' | 'csv')}
                >
                  <ToggleGroupItem value="json">
                    <View className="flex-row items-center gap-2">
                      <FileJson size={16} className="text-foreground" />
                      <Text>{t('memory.jsonFull')}</Text>
                    </View>
                  </ToggleGroupItem>
                  <ToggleGroupItem value="csv">
                    <View className="flex-row items-center gap-2">
                      <FileText size={16} className="text-foreground" />
                      <Text>{t('memory.csv')}</Text>
                    </View>
                  </ToggleGroupItem>
                </ToggleGroup>

                <Text className="text-xs text-muted-foreground mt-1">
                  {exportFormat === 'json'
                    ? t('memory.jsonDescription')
                    : t('memory.csvDescription')}
                </Text>
              </View>
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
            <View className="gap-2">
              <Label>{t('memory.selectFile')}</Label>
              <input
                type="file"
                accept=".json"
                onChange={handleFileSelect}
                className="block w-full text-sm"
              />
            </View>

            {importPreview && (
              <View className="bg-muted rounded-lg p-3 gap-2">
                <Text className="text-sm font-medium">{t('memory.preview')}</Text>
                <Text className="text-xs">{t('memory.totalToImport')}: {importPreview.totalToImport}</Text>
                <Text className="text-xs">{t('memory.newMemoriesCount')}: {importPreview.newTitles}</Text>
                <Text className="text-xs">{t('memory.duplicatesCount')}: {importPreview.duplicateTitles}</Text>
                <Text className="text-xs">{t('memory.finalTotal')}: {importPreview.estimatedFinalTotal}</Text>
                {importPreview.memoryLimit !== -1 && (
                  <Text className="text-xs">{t('memory.memoryLimit')}: {importPreview.memoryLimit}</Text>
                )}
              </View>
            )}

            {importFile && (
              <View className="gap-2">
                <Label>{t('memory.importStrategy')}</Label>
                <ToggleGroup
                  type="single"
                  value={importStrategy}
                  onValueChange={(val) => {
                    if (val === 'merge' || val === 'skip-duplicates' || val === 'replace') {
                      setImportStrategy(val);
                    }
                  }}
                >
                  <ToggleGroupItem value="merge">
                    <Text>{t('memory.merge')}</Text>
                  </ToggleGroupItem>
                  <ToggleGroupItem value="skip-duplicates">
                    <Text>{t('memory.skipDupes')}</Text>
                  </ToggleGroupItem>
                  <ToggleGroupItem value="replace">
                    <Text>{t('memory.replaceAll')}</Text>
                  </ToggleGroupItem>
                </ToggleGroup>

                <Text className="text-xs text-muted-foreground mt-1">
                  {importStrategy === 'merge' && t('memory.mergeDescription')}
                  {importStrategy === 'skip-duplicates' && t('memory.skipDescription')}
                  {importStrategy === 'replace' && t('memory.replaceDescription')}
                </Text>
              </View>
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
            <ScrollView style={{ maxHeight: 400 }}>
              <View className="gap-3">
                {duplicates.map((dup, i) => (
                  <View key={i} className="border border-border rounded-lg p-3 gap-2">
                    <View className="bg-muted rounded-md px-2 py-1 self-start">
                      <Text className="text-[10px] text-muted-foreground font-medium">
                        {dup.reason === 'identical_summary' ? t('memory.identicalValue') : t('memory.similarKey')}
                      </Text>
                    </View>
                    <View className="gap-1">
                      <Text className="text-xs font-semibold text-foreground">
                        {dup.memory1?.title}
                      </Text>
                      <Text className="text-xs text-muted-foreground" numberOfLines={2}>
                        {dup.memory1?.summary}
                      </Text>
                    </View>
                    <View className="h-px bg-border" />
                    <View className="gap-1">
                      <Text className="text-xs font-semibold text-foreground">
                        {dup.memory2?.title}
                      </Text>
                      <Text className="text-xs text-muted-foreground" numberOfLines={2}>
                        {dup.memory2?.summary}
                      </Text>
                    </View>
                    <View className="flex-row gap-2 mt-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 h-7"
                        onPress={() => {
                          const targetId = dup.memory2?._id;
                          if (targetId) handleDeleteMemory(targetId);
                          setDuplicates(prev => prev.filter((_, idx) => idx !== i));
                        }}
                      >
                        <Text className="text-xs">{t('memory.keepFirst')}</Text>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 h-7"
                        onPress={() => {
                          const targetId = dup.memory1?._id;
                          if (targetId) handleDeleteMemory(targetId);
                          setDuplicates(prev => prev.filter((_, idx) => idx !== i));
                        }}
                      >
                        <Text className="text-xs">{t('memory.keepSecond')}</Text>
                      </Button>
                    </View>
                  </View>
                ))}
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
            <View className="gap-3">
              <View className="bg-muted rounded-lg p-3">
                <Text className="text-sm text-foreground" selectable>
                  {PROVIDER_IMPORT_PROMPT}
                </Text>
              </View>
              <Button
                variant="outline"
                onPress={() => {
                  if (typeof navigator !== 'undefined' && navigator.clipboard) {
                    navigator.clipboard.writeText(PROVIDER_IMPORT_PROMPT);
                    toast.success(t('memory.promptCopied'));
                  }
                }}
              >
                <View className="flex-row items-center gap-2">
                  <Copy size={16} className="text-foreground" />
                  <Text>{t('memory.copyPrompt')}</Text>
                </View>
              </Button>
            </View>
          ) : (
            <View className="gap-3">
              <View className="gap-2">
                <Label>{t('memory.pasteResponseLabel')}</Label>
                <Textarea
                  value={providerPastedText}
                  onChangeText={setProviderPastedText}
                  placeholder={t('memory.pasteResponsePlaceholder')}
                  editable={!providerImporting}
                  style={{ minHeight: 160 }}
                />
              </View>

              {providerImportResult && (
                <View className="bg-muted rounded-lg p-3 gap-1">
                  <Text className="text-sm font-medium">{t('memory.providerImportResultHeading')}</Text>
                  {providerImportResult.length === 0 ? (
                    <Text className="text-xs text-muted-foreground">{t('memory.providerImportNoneFound')}</Text>
                  ) : (
                    providerImportResult.map((m, i) => (
                      <Text key={i} className="text-xs text-muted-foreground">• {m.title}: {m.summary}</Text>
                    ))
                  )}
                </View>
              )}
            </View>
          )}

      </Dialog>
    </View>
  );
}

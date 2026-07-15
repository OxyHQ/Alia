import React, { useState, useEffect, useMemo } from 'react';
import { View, ScrollView, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { confirm } from "@oxyhq/bloom/alert-dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useOxy, useAuth } from "@oxyhq/services";
import { generateAPIUrl } from "@/lib/generate-api-url";
import {
  Brain,
  Plus,
  Search,
  Download,
  Upload,
  FileJson,
  FileText,
  Wand2,
  Copy,
} from "lucide-react-native";
import { useTranslation } from "@/lib/hooks/use-translation";
import { useUserData } from "@/lib/hooks/use-user-data";
import { useUserDataStore } from "@/lib/stores/user-data-store";
import { cn } from "@/lib/utils";
import { toast } from "@/components/sonner";
import { useColorScheme } from "@/lib/useColorScheme";
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

/** A single hit from semantic memory search (maps back onto a {@link Memory}). */
interface SemanticResult {
  title: string;
  summary: string;
  type?: MemoryType;
  score?: number;
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
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const [showDialog, setShowDialog] = useState(false);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [saving, setSaving] = useState(false);

  // Form state
  const [formTitle, setFormTitle] = useState("");
  const [formSummary, setFormSummary] = useState("");
  const [formType, setFormType] = useState<MemoryType>('topic');

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

  // Semantic search state
  const [semanticMode, setSemanticMode] = useState(false);
  const [semanticResults, setSemanticResults] = useState<SemanticResult[] | null>(null);
  const [semanticLoading, setSemanticLoading] = useState(false);

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

  const handleOpenDialog = (memory?: Memory, defaultType: MemoryType = 'topic') => {
    if (memory) {
      setEditingMemory(memory);
      setFormTitle(memory.title);
      setFormSummary(memory.summary);
      setFormType(memory.type);
    } else {
      setEditingMemory(null);
      setFormTitle("");
      setFormSummary("");
      setFormType(defaultType);
    }
    setShowDialog(true);
  };

  const handleCloseDialog = () => {
    setShowDialog(false);
    setEditingMemory(null);
    setFormTitle("");
    setFormSummary("");
    setFormType('topic');
  };

  const getAuthHeaders = (contentType?: boolean): Record<string, string> => {
    const headers: Record<string, string> = {};
    const token = oxyServices.getAccessToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (contentType) headers['Content-Type'] = 'application/json';
    return headers;
  };

  const handleSaveMemory = async () => {
    if (!isAuthenticated || !formTitle.trim() || !formSummary.trim()) {
      toast.error(t("memory.titleSummaryRequired"));
      return;
    }

    setSaving(true);
    try {
      if (editingMemory) {
        const apiUrl = generateAPIUrl(`/memory/${editingMemory._id}`);
        const response = await fetch(apiUrl, {
          method: 'PUT',
          headers: getAuthHeaders(true),
          body: JSON.stringify({
            title: formTitle,
            summary: formSummary,
            type: formType,
          }),
        });

        if (response.ok) {
          const updatedMemory = await response.json();
          setMemory(updatedMemory);
          handleCloseDialog();
          toast.success(t("memory.memoryUpdated"));
        }
      } else {
        const apiUrl = generateAPIUrl('/memory/add');
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: getAuthHeaders(true),
          body: JSON.stringify({
            title: formTitle,
            summary: formSummary,
            type: formType,
          }),
        });

        if (response.ok) {
          const updatedMemory = await response.json();
          setMemory(updatedMemory);
          handleCloseDialog();
          toast.success(t("memory.memoryAdded"));
        }
      }
    } catch (error) {
      console.error("Error saving memory:", error);
      toast.error(t("memory.failedToSave"));
    } finally {
      setSaving(false);
    }
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

  // Semantic search handler
  const performSemanticSearch = async (query: string) => {
    if (!isAuthenticated || !query.trim()) {
      setSemanticResults(null);
      return;
    }

    setSemanticLoading(true);
    try {
      const apiUrl = generateAPIUrl(`/memory/semantic-search?q=${encodeURIComponent(query)}&limit=20`);
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: getAuthHeaders(),
      });

      if (response.ok) {
        const data = await response.json();
        setSemanticResults(data.results || []);
      } else {
        setSemanticResults(null);
        toast.error(t("memory.semanticUnavailable"));
        setSemanticMode(false);
      }
    } catch (error) {
      console.error("Semantic search error:", error);
      setSemanticResults(null);
      setSemanticMode(false);
    } finally {
      setSemanticLoading(false);
    }
  };

  // Debounced semantic search
  useEffect(() => {
    if (!semanticMode || !searchQuery.trim()) {
      setSemanticResults(null);
      return;
    }

    const timer = setTimeout(() => {
      performSemanticSearch(searchQuery);
    }, 500);

    return () => clearTimeout(timer);
  }, [searchQuery, semanticMode]);

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

  // Determine which memories to show (search or semantic overlay), before grouping
  const displayMemories = useMemo(() => {
    if (semanticMode && semanticResults) {
      return semanticResults.map((r) => {
        const found = memories.find(m => m.title === r.title && m.summary === r.summary);
        return found || { _id: r.title, title: r.title, summary: r.summary, type: r.type || 'topic', score: r.score, createdAt: '', updatedAt: '' };
      });
    }
    return filteredMemories;
  }, [semanticMode, semanticResults, filteredMemories, memories]);

  const groupedByType = useMemo(() => {
    return {
      profile: displayMemories.filter(m => m.type === 'profile'),
      topic: displayMemories.filter(m => m.type === 'topic'),
      person: displayMemories.filter(m => m.type === 'person'),
    };
  }, [displayMemories]);

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

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("memory.title")} />
      <ScrollView className="flex-1" contentContainerClassName="max-w-2xl">
        {/* Settings toggles */}
        <View className="px-4 pt-2 pb-1">
          <View className="flex-row items-center justify-between gap-4 py-3 border-b border-border">
            <View className="flex-1 min-w-0 gap-0.5">
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
            <View className="flex-1 min-w-0 gap-0.5">
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
            <View className="flex-1 min-w-0 gap-0.5">
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
            <View className="flex-1 flex-row items-center gap-2 bg-muted rounded-lg px-3 h-9">
              <Search size={15} className="text-muted-foreground" />
              <Input
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder={semanticMode ? t("memory.aiSearchPlaceholder") : t("memory.searchPlaceholder")}
                className="flex-1 border-0 bg-transparent h-auto p-0 text-sm web:focus-visible:ring-0"
                placeholderTextColor={colors.mutedForeground}
              />
              {semanticLoading && (
                <Text className="text-xs text-muted-foreground">...</Text>
              )}
              <Pressable
                onPress={() => {
                  setSemanticMode(!semanticMode);
                  if (!semanticMode) {
                    toast.info(t("memory.aiSearchEnabled"));
                  }
                }}
                className={cn(
                  "px-2 py-0.5 rounded-md",
                  semanticMode ? "bg-primary/15" : ""
                )}
              >
                <View className="flex-row items-center gap-1">
                  <Wand2 size={11} className={semanticMode ? "text-primary" : "text-muted-foreground"} />
                  <Text className={cn("text-[11px] font-medium", semanticMode ? "text-primary" : "text-muted-foreground")}>
                    AI
                  </Text>
                </View>
              </Pressable>
            </View>

            <Button
              onPress={() => handleOpenDialog()}
              size="sm"
              className="h-9 px-3 rounded-lg"
            >
              <View className="flex-row items-center gap-1.5">
                <Plus size={16} className="text-primary-foreground" />
              </View>
            </Button>
          </View>

          <View className="flex-row items-center justify-between">
            <Text className="text-xs text-muted-foreground">
              {displayMemories.length} {displayMemories.length === 1 ? 'memoria' : 'memorias'}
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
                    if (found) handleOpenDialog(found);
                  }}
                  onDelete={handleDeleteMemory}
                />
              ))}
            </>
          )}
        </View>
      </ScrollView>

      {/* Add/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent closeButton={true}>
          <DialogHeader>
            <DialogTitle>
              {editingMemory ? t('memory.editMemory') : t('memory.newMemory')}
            </DialogTitle>
            <DialogDescription>
              {editingMemory
                ? t('memory.updateDetails')
                : t('memory.addForAlia')}
            </DialogDescription>
          </DialogHeader>

          <View className="gap-4">
            <View className="gap-2">
              <Label nativeID="title">{t('memory.titleLabel')}</Label>
              <Input
                aria-labelledby="title"
                value={formTitle}
                onChangeText={setFormTitle}
                placeholder={t('memory.titlePlaceholder')}
                editable={!saving}
              />
            </View>

            <View className="gap-2">
              <Label nativeID="summary">{t('memory.summaryLabel')}</Label>
              <Textarea
                aria-labelledby="summary"
                value={formSummary}
                onChangeText={setFormSummary}
                placeholder={t('memory.summaryPlaceholder')}
                editable={!saving}
              />
            </View>

            <View className="gap-2">
              <Label>{t('memory.typeLabel')}</Label>
              <ToggleGroup
                type="single"
                value={formType}
                onValueChange={(val) => {
                  if (val === 'profile' || val === 'topic' || val === 'person') {
                    setFormType(val);
                  }
                }}
              >
                <ToggleGroupItem value="profile">
                  <Text>{t('memory.sectionYou')}</Text>
                </ToggleGroupItem>
                <ToggleGroupItem value="topic">
                  <Text>{t('memory.sectionTopics')}</Text>
                </ToggleGroupItem>
                <ToggleGroupItem value="person">
                  <Text>{t('memory.sectionPeople')}</Text>
                </ToggleGroupItem>
              </ToggleGroup>
            </View>
          </View>

          <DialogFooter>
            <Button
              variant="outline"
              className="flex-1"
              onPress={handleCloseDialog}
              disabled={saving}
            >
              <Text>{t('common.cancel')}</Text>
            </Button>
            <Button
              className="flex-1"
              onPress={handleSaveMemory}
              disabled={saving}
            >
              <Text>{saving ? t('memory.saving') : editingMemory ? t('memory.update') : t('memory.add')}</Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Export Dialog */}
      <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
        <DialogContent closeButton={true}>
          <DialogHeader>
            <DialogTitle>{t('memory.exportTitle')}</DialogTitle>
            <DialogDescription>
              {t('memory.exportDescription')}
            </DialogDescription>
          </DialogHeader>

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

          <DialogFooter>
            <Button
              variant="outline"
              className="flex-1"
              onPress={() => setShowExportDialog(false)}
            >
              <Text>{t('common.cancel')}</Text>
            </Button>
            <Button
              className="flex-1"
              onPress={() => handleExport(exportFormat)}
            >
              <View className="flex-row items-center gap-2">
                <Download size={16} className="text-primary-foreground" />
                <Text>{t('memory.download', { format: exportFormat.toUpperCase() })}</Text>
              </View>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Dialog (file-based) */}
      <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
        <DialogContent closeButton={true}>
          <DialogHeader>
            <DialogTitle>{t('memory.importTitle')}</DialogTitle>
            <DialogDescription>
              {t('memory.importDescription')}
            </DialogDescription>
          </DialogHeader>

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

          <DialogFooter>
            <Button
              variant="outline"
              className="flex-1"
              onPress={() => setShowImportDialog(false)}
              disabled={importing}
            >
              <Text>{t('common.cancel')}</Text>
            </Button>
            <Button
              className="flex-1"
              onPress={handleImport}
              disabled={!importFile || importing}
            >
              <Text>{importing ? t('memory.importing') : t('memory.import')}</Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Duplicates Dialog */}
      <Dialog open={showDuplicatesDialog} onOpenChange={setShowDuplicatesDialog}>
        <DialogContent closeButton={true}>
          <DialogHeader>
            <DialogTitle>{t('memory.duplicateMemories')}</DialogTitle>
            <DialogDescription>
              {duplicates.length === 0
                ? t('memory.noDuplicates')
                : t('memory.foundDuplicates', { count: duplicates.length })}
            </DialogDescription>
          </DialogHeader>

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

          <DialogFooter>
            <Button onPress={() => setShowDuplicatesDialog(false)}>
              <Text>{t('common.done')}</Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import from other AI provider */}
      <Dialog open={showProviderImportDialog} onOpenChange={(open) => { if (!open) handleCloseProviderImport(); else setShowProviderImportDialog(true); }}>
        <DialogContent closeButton={true}>
          <DialogHeader>
            <DialogTitle>{t('memory.importFromProvider')}</DialogTitle>
            <DialogDescription>
              {providerImportStep === 'prompt'
                ? t('memory.providerImportStepPromptDescription')
                : t('memory.providerImportStepPasteDescription')}
            </DialogDescription>
          </DialogHeader>

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

          <DialogFooter>
            {providerImportStep === 'prompt' ? (
              <Button className="flex-1" onPress={() => setProviderImportStep('paste')}>
                <Text>{t('memory.nextStep')}</Text>
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  className="flex-1"
                  onPress={handleCloseProviderImport}
                  disabled={providerImporting}
                >
                  <Text>{providerImportResult ? t('common.done') : t('common.cancel')}</Text>
                </Button>
                {!providerImportResult && (
                  <Button
                    className="flex-1"
                    onPress={handleProviderImport}
                    disabled={!providerPastedText.trim() || providerImporting}
                  >
                    <Text>{providerImporting ? t('memory.importing') : t('memory.import')}</Text>
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}

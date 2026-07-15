import React, { useState, useEffect, useMemo } from 'react';
import { View, ScrollView, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
  Trash2,
  Search,
  Heart,
  Briefcase,
  Target,
  Star,
  User,
  Sparkles,
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

interface Memory {
  _id: string;
  key: string;
  value: string;
  category?: string;
  createdAt: string;
  updatedAt: string;
}

/** A single hit from semantic memory search (maps back onto a {@link Memory}). */
interface SemanticResult {
  key: string;
  value: string;
  category?: string;
  score?: number;
}

/** Aggregate counts returned by the export-preview endpoint. */
interface ExportStats {
  totalMemories: number;
  totalCategories: number;
  estimatedSizeJSON: number;
}

/** Summary returned by the import-validate endpoint before committing an import. */
interface ImportPreview {
  totalToImport: number;
  newKeys: number;
  duplicateKeys: number;
  estimatedFinalTotal: number;
  memoryLimit: number;
}

/** A pair of memories flagged as duplicates by the dedupe endpoint. */
interface DuplicatePair {
  reason: string;
  memory1?: { _id: string; key: string; value: string };
  memory2?: { _id: string; key: string; value: string };
}

/** Icon component shared by the category config (lucide-react-native icons). */
type CategoryIcon = React.ComponentType<{ size?: number; color?: string; className?: string }>;

interface UserMemory {
  memories: Memory[];
}

const CATEGORY_CONFIG: Record<string, { icon: CategoryIcon; color: string; bgColor: string }> = {
  'preferencia': { icon: Heart, color: 'text-pink-600', bgColor: 'bg-pink-500/10' },
  'preference': { icon: Heart, color: 'text-pink-600', bgColor: 'bg-pink-500/10' },
  'personal': { icon: User, color: 'text-blue-600', bgColor: 'bg-blue-500/10' },
  'trabajo': { icon: Briefcase, color: 'text-orange-600', bgColor: 'bg-orange-500/10' },
  'work': { icon: Briefcase, color: 'text-orange-600', bgColor: 'bg-orange-500/10' },
  'objetivo': { icon: Target, color: 'text-green-600', bgColor: 'bg-green-500/10' },
  'goal': { icon: Target, color: 'text-green-600', bgColor: 'bg-green-500/10' },
  'experiencia': { icon: Sparkles, color: 'text-purple-600', bgColor: 'bg-purple-500/10' },
  'experience': { icon: Sparkles, color: 'text-purple-600', bgColor: 'bg-purple-500/10' },
  'default': { icon: Star, color: 'text-primary', bgColor: 'bg-primary/10' }
};

const SUGGESTED_CATEGORIES = ['preferencia', 'personal', 'trabajo', 'objetivo', 'experiencia'];

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
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [saving, setSaving] = useState(false);

  // Form state
  const [formKey, setFormKey] = useState("");
  const [formValue, setFormValue] = useState("");
  const [formCategory, setFormCategory] = useState("");

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

  const memories = memory?.memories || [];

  // Redirect if not authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      signIn().catch(() => {});
    }
  }, [isAuthenticated, signIn]);

  // Get unique categories
  const categories = useMemo(() => {
    const cats = new Set(memories.map(m => m.category || 'uncategorized'));
    return ['All', ...Array.from(cats).sort()];
  }, [memories]);

  // Filter memories
  const filteredMemories = useMemo(() => {
    let filtered = memories;

    // Filter by category
    if (selectedCategory && selectedCategory !== 'All') {
      filtered = filtered.filter(m => (m.category || 'uncategorized') === selectedCategory);
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(m =>
        m.key.toLowerCase().includes(query) ||
        m.value.toLowerCase().includes(query) ||
        (m.category && m.category.toLowerCase().includes(query))
      );
    }

    return filtered;
  }, [memories, searchQuery, selectedCategory]);

  const handleOpenDialog = (memory?: Memory) => {
    if (memory) {
      setEditingMemory(memory);
      setFormKey(memory.key);
      setFormValue(memory.value);
      setFormCategory(memory.category || "");
    } else {
      setEditingMemory(null);
      setFormKey("");
      setFormValue("");
      setFormCategory("");
    }
    setShowDialog(true);
  };

  const handleCloseDialog = () => {
    setShowDialog(false);
    setEditingMemory(null);
    setFormKey("");
    setFormValue("");
    setFormCategory("");
  };

  const getAuthHeaders = (contentType?: boolean): Record<string, string> => {
    const headers: Record<string, string> = {};
    const token = oxyServices.getAccessToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (contentType) headers['Content-Type'] = 'application/json';
    return headers;
  };

  const handleSaveMemory = async () => {
    if (!isAuthenticated || !formKey.trim() || !formValue.trim()) {
      toast.error(t("memory.keyValueRequired"));
      return;
    }

    setSaving(true);
    try {
      if (editingMemory) {
        // Update existing memory
        const apiUrl = generateAPIUrl(`/memory/${editingMemory._id}`);
        const response = await fetch(apiUrl, {
          method: 'PUT',
          headers: getAuthHeaders(true),
          body: JSON.stringify({
            key: formKey,
            value: formValue,
            category: formCategory || undefined,
          }),
        });

        if (response.ok) {
          const updatedMemory = await response.json();
          setMemory(updatedMemory);
          handleCloseDialog();
          toast.success(t("memory.memoryUpdated"));
        }
      } else {
        // Add new memory
        const apiUrl = generateAPIUrl('/memory/add');
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: getAuthHeaders(true),
          body: JSON.stringify({
            key: formKey,
            value: formValue,
            category: formCategory || undefined,
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

  const getCategoryConfig = (category?: string) => {
    const cat = (category || 'default').toLowerCase();
    return CATEGORY_CONFIG[cat] || CATEGORY_CONFIG.default;
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
        // Fallback to text search silently
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

  // Determine which memories to show
  const displayMemories = useMemo(() => {
    if (semanticMode && semanticResults) {
      // Map semantic results back to memory objects
      return semanticResults.map((r) => {
        const found = memories.find(m => m.key === r.key && m.value === r.value);
        return found || { _id: r.key, key: r.key, value: r.value, category: r.category, score: r.score, createdAt: '', updatedAt: '' };
      });
    }
    return filteredMemories;
  }, [semanticMode, semanticResults, filteredMemories, memories]);

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

      // Validate format
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

        // Refresh memory data
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
        {/* Compact Toolbar */}
        <View className="px-4 pt-3 pb-2 gap-2">
          {/* Row 1: Search + Add */}
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

          {/* Row 2: Count + actions */}
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

        {/* Category Toggle Group */}
        {memories.length > 0 && (
          <View className="px-4 pb-2">
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <ToggleGroup
                type="single"
                value={selectedCategory}
                onValueChange={(value) => setSelectedCategory(value as string)}
              >
                {categories.map((category) => (
                  <ToggleGroupItem key={category} value={category}>
                    {category}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </ScrollView>
          </View>
        )}

        {/* Memory List */}
        <View className="px-4 pb-4">
          {displayMemories.length === 0 ? (
            <View className="items-center justify-center py-12">
              <Brain size={32} className="text-muted-foreground opacity-40" />
              <Text className="text-sm font-medium text-muted-foreground mt-3">
                {memories.length === 0 ? t('memory.noMemories') : t('memory.noMemoriesFound')}
              </Text>
              <Text className="text-xs text-muted-foreground text-center mt-1 max-w-xs">
                {searchQuery
                  ? semanticMode ? t('memory.noSemanticResults') : t('memory.noMemoriesFound')
                  : t('memory.shareInfo')
                }
              </Text>
            </View>
          ) : (
            <View className="border border-border rounded-xl overflow-hidden bg-surface">
              {displayMemories.map((memory, index) => (
                <MemoryRow
                  key={memory._id}
                  memory={memory}
                  onEdit={() => handleOpenDialog(memory)}
                  onDelete={() => handleDeleteMemory(memory._id)}
                  getCategoryConfig={getCategoryConfig}
                  t={t}
                  isLast={index === displayMemories.length - 1}
                />
              ))}
            </View>
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
            {/* Key Field */}
            <View className="gap-2">
              <Label nativeID="key">{t('memory.keyLabel')}</Label>
              <Input
                aria-labelledby="key"
                value={formKey}
                onChangeText={setFormKey}
                placeholder={t('memory.keyPlaceholder')}
                editable={!saving}
              />
            </View>

            {/* Value Field */}
            <View className="gap-2">
              <Label nativeID="value">{t('memory.valueLabel')}</Label>
              <Textarea
                aria-labelledby="value"
                value={formValue}
                onChangeText={setFormValue}
                placeholder={t('memory.valuePlaceholder')}
                editable={!saving}
              />
            </View>

            {/* Category Field */}
            <View className="gap-2">
              <Label nativeID="category">{t('memory.categoryLabel')}</Label>
              <Input
                aria-labelledby="category"
                value={formCategory}
                onChangeText={setFormCategory}
                placeholder={t('memory.categoryPlaceholder')}
                editable={!saving}
              />

              {/* Suggested Categories */}
              <View className="flex-row flex-wrap gap-2 mt-1">
                {SUGGESTED_CATEGORIES.map((cat) => (
                  <Pressable
                    key={cat}
                    onPress={() => setFormCategory(cat)}
                    className={cn(
                      "px-2 py-1 rounded-md border border-border active:opacity-70",
                      formCategory === cat && "bg-primary/10 border-primary"
                    )}
                  >
                    <Text className={cn(
                      "text-xs",
                      formCategory === cat ? "text-primary" : "text-muted-foreground"
                    )}>
                      {cat}
                    </Text>
                  </Pressable>
                ))}
              </View>
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
                <Text className="text-sm">{t('memory.categories')}: {exportStats.totalCategories}</Text>
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

      {/* Import Dialog */}
      <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
        <DialogContent closeButton={true}>
          <DialogHeader>
            <DialogTitle>{t('memory.importTitle')}</DialogTitle>
            <DialogDescription>
              {t('memory.importDescription')}
            </DialogDescription>
          </DialogHeader>

          <View className="gap-4">
            {/* File Input */}
            <View className="gap-2">
              <Label>{t('memory.selectFile')}</Label>
              <input
                type="file"
                accept=".json"
                onChange={handleFileSelect}
                className="block w-full text-sm"
              />
            </View>

            {/* Preview */}
            {importPreview && (
              <View className="bg-muted rounded-lg p-3 gap-2">
                <Text className="text-sm font-medium">{t('memory.preview')}</Text>
                <Text className="text-xs">{t('memory.totalToImport')}: {importPreview.totalToImport}</Text>
                <Text className="text-xs">{t('memory.newMemoriesCount')}: {importPreview.newKeys}</Text>
                <Text className="text-xs">{t('memory.duplicatesCount')}: {importPreview.duplicateKeys}</Text>
                <Text className="text-xs">{t('memory.finalTotal')}: {importPreview.estimatedFinalTotal}</Text>
                {importPreview.memoryLimit !== -1 && (
                  <Text className="text-xs">{t('memory.memoryLimit')}: {importPreview.memoryLimit}</Text>
                )}
              </View>
            )}

            {/* Strategy Selection */}
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
                        {dup.reason === 'identical_value' ? t('memory.identicalValue') : t('memory.similarKey')}
                      </Text>
                    </View>
                    <View className="gap-1">
                      <Text className="text-xs font-semibold text-foreground">
                        {dup.memory1?.key}
                      </Text>
                      <Text className="text-xs text-muted-foreground" numberOfLines={2}>
                        {dup.memory1?.value}
                      </Text>
                    </View>
                    <View className="h-px bg-border" />
                    <View className="gap-1">
                      <Text className="text-xs font-semibold text-foreground">
                        {dup.memory2?.key}
                      </Text>
                      <Text className="text-xs text-muted-foreground" numberOfLines={2}>
                        {dup.memory2?.value}
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
    </View>
  );
}

function MemoryRow({
  memory,
  onEdit,
  onDelete,
  getCategoryConfig,
  t,
  isLast,
}: {
  memory: Memory;
  onEdit: () => void;
  onDelete: () => void;
  getCategoryConfig: (category?: string) => { icon: CategoryIcon; color: string; bgColor: string };
  t: (key: string, params?: Record<string, unknown>) => string;
  isLast: boolean;
}) {
  const config = getCategoryConfig(memory.category);
  const CategoryIcon = config.icon;

  return (
    <Pressable
      onPress={onEdit}
      className={cn(
        "flex-row items-center px-3 py-2.5 active:bg-accent/50",
        !isLast && "border-b border-border"
      )}
    >
      {/* Category icon */}
      <View className={cn("w-7 h-7 rounded-lg items-center justify-center mr-3", config.bgColor)}>
        <CategoryIcon size={14} className={config.color} />
      </View>

      {/* Content */}
      <View className="flex-1 mr-2">
        <View className="flex-row items-center gap-1.5">
          <Text className="text-sm font-medium text-foreground flex-1" numberOfLines={1}>
            {memory.key}
          </Text>
          <Text className="text-[10px] text-muted-foreground/60">
            {new Date(memory.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </Text>
        </View>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {memory.value}
        </Text>
      </View>

      {/* Delete */}
      <Pressable
        onPress={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="w-7 h-7 items-center justify-center rounded-md active:bg-destructive/10"
      >
        <Trash2 size={14} className="text-muted-foreground" />
      </Pressable>
    </Pressable>
  );
}

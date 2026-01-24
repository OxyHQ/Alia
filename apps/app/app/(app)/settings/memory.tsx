import React, { useState, useEffect, useMemo } from 'react';
import { View, ScrollView, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useOxy } from "@oxyhq/services";
import { useRouter } from "expo-router";
import { generateAPIUrl } from "@/lib/generate-api-url";
import {
  Brain,
  Plus,
  Trash2,
  Edit3,
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
} from "lucide-react-native";
import { useUserData } from "@/hooks/useUserData";
import { useUserDataStore } from "@/lib/stores/user-data-store";
import { cn } from "@/lib/utils";
import { toast } from "@/components/sonner";
import { useColorScheme } from "@/lib/useColorScheme";

interface Memory {
  _id: string;
  key: string;
  value: string;
  category?: string;
  createdAt: string;
  updatedAt: string;
}

interface UserMemory {
  memories: Memory[];
}

const CATEGORY_CONFIG: Record<string, { icon: any; color: string; bgColor: string }> = {
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
  const router = useRouter();
  const { isAuthenticated, activeSessionId } = useOxy();
  const { memory, loading } = useUserData();
  const setMemory = useUserDataStore((state) => state.setMemory);
  const { colors } = useColorScheme();
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
  const [exportStats, setExportStats] = useState<any>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importStrategy, setImportStrategy] = useState<'merge' | 'replace' | 'skip-duplicates'>('merge');
  const [importPreview, setImportPreview] = useState<any>(null);
  const [importing, setImporting] = useState(false);

  // Delete confirmation state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [memoryToDelete, setMemoryToDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const memories = memory?.memories || [];

  // Redirect if not authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated]);

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

  const handleSaveMemory = async () => {
    if (!activeSessionId || !formKey.trim() || !formValue.trim()) {
      toast.error("Key and value are required");
      return;
    }

    setSaving(true);
    try {
      if (editingMemory) {
        // Update existing memory
        const apiUrl = generateAPIUrl(`/memory/${editingMemory._id}`);
        const response = await fetch(apiUrl, {
          method: 'PUT',
          headers: {
            'x-session-id': activeSessionId,
            'Content-Type': 'application/json',
          },
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
          toast.success("Memory updated successfully");
        }
      } else {
        // Add new memory
        const apiUrl = generateAPIUrl('/memory/add');
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'x-session-id': activeSessionId,
            'Content-Type': 'application/json',
          },
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
          toast.success("Memory added successfully");
        }
      }
    } catch (error) {
      console.error("Error saving memory:", error);
      toast.error("Failed to save memory");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteMemory = (memoryId: string) => {
    setMemoryToDelete(memoryId);
    setShowDeleteDialog(true);
  };

  const confirmDeleteMemory = async () => {
    if (!activeSessionId || !memoryToDelete) return;

    setDeleting(true);
    try {
      const apiUrl = generateAPIUrl(`/memory/${memoryToDelete}`);
      const response = await fetch(apiUrl, {
        method: 'DELETE',
        headers: {
          'x-session-id': activeSessionId,
        },
      });

      if (response.ok) {
        const updatedMemory = await response.json();
        setMemory(updatedMemory);
        toast.success("Memory deleted successfully");
      }
    } catch (error) {
      console.error("Error deleting memory:", error);
      toast.error("Failed to delete memory");
    } finally {
      setDeleting(false);
      setMemoryToDelete(null);
    }
  };

  const getCategoryConfig = (category?: string) => {
    const cat = (category || 'default').toLowerCase();
    return CATEGORY_CONFIG[cat] || CATEGORY_CONFIG.default;
  };

  // Export handlers
  const loadExportStats = async () => {
    if (!activeSessionId) return;

    try {
      const apiUrl = generateAPIUrl('/memory/export/preview');
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'x-session-id': activeSessionId,
        },
      });

      if (response.ok) {
        const stats = await response.json();
        setExportStats(stats);
      }
    } catch (error) {
      console.error('Export stats error:', error);
      toast.error('Failed to load export statistics');
    }
  };

  const handleExport = async (format: 'json' | 'csv') => {
    if (!activeSessionId) return;

    try {
      const apiUrl = generateAPIUrl(`/memory/export/${format}`);
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'x-session-id': activeSessionId,
        },
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

        toast.success(`Memories exported as ${format.toUpperCase()}`);
        setShowExportDialog(false);
      } else {
        const error = await response.json();
        toast.error(error.error || 'Export failed');
      }
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export memories');
    }
  };

  // Import handlers
  const handleFileSelect = async (event: any) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      toast.error('File too large (max 5MB)');
      return;
    }

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // Validate format
      const response = await fetch(generateAPIUrl('/memory/import/validate'), {
        method: 'POST',
        headers: {
          'x-session-id': activeSessionId!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data }),
      });

      const result = await response.json();

      if (result.valid) {
        setImportFile(file);
        setImportPreview(result.analysis);
      } else {
        toast.error('Invalid file format');
        console.error('Validation errors:', result.errors);
      }
    } catch (error) {
      toast.error('Failed to read file');
      console.error(error);
    }
  };

  const handleImport = async () => {
    if (!importFile || !activeSessionId) return;

    setImporting(true);
    try {
      const text = await importFile.text();
      const data = JSON.parse(text);

      const response = await fetch(generateAPIUrl('/memory/import'), {
        method: 'POST',
        headers: {
          'x-session-id': activeSessionId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data, strategy: importStrategy }),
      });

      if (response.ok) {
        const result = await response.json();

        // Refresh memory data
        const memResponse = await fetch(generateAPIUrl('/memory'), {
          headers: { 'x-session-id': activeSessionId },
        });
        if (memResponse.ok) {
          setMemory(await memResponse.json());
        }

        toast.success(
          `Import successful: ${result.stats.imported} added, ` +
          `${result.stats.updated} updated, ${result.stats.skipped} skipped`
        );

        setShowImportDialog(false);
        setImportFile(null);
        setImportPreview(null);
      } else {
        const error = await response.json();
        toast.error(error.error || 'Import failed');
      }
    } catch (error) {
      console.error('Import error:', error);
      toast.error('Failed to import memories');
    } finally {
      setImporting(false);
    }
  };

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Text>Loading...</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1">
        {/* Hero Section - Centered */}
        <View className="items-center px-6 py-12">
          <Brain size={48} className="text-primary mb-4" />
          <Text className="text-4xl font-bold text-foreground mb-3 text-center">
            Memory
          </Text>
          <Text className="text-base text-muted-foreground mb-6 text-center max-w-md">
            Personal knowledge that Alia remembers across conversations. Share information naturally and it's saved automatically.
          </Text>

          {/* Search Bar */}
          <View className="w-full max-w-md flex-row items-center gap-2 bg-muted rounded-full px-4 py-3 mb-4">
            <Search size={18} className="text-muted-foreground" />
            <Input
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search memories..."
              className="flex-1 border-0 bg-transparent h-auto p-0 web:focus-visible:ring-0"
              placeholderTextColor={colors.mutedForeground}
            />
          </View>

          {/* Create Button */}
          <Button
            onPress={() => handleOpenDialog()}
            className="h-11 px-6 rounded-full"
          >
            <View className="flex-row items-center gap-2">
              <Plus size={18} className="text-primary-foreground" />
              <Text className="text-sm font-semibold text-primary-foreground">
                Add Memory
              </Text>
            </View>
          </Button>

          {/* Export/Import Buttons */}
          <View className="flex-row gap-2 mt-3">
            <Button
              onPress={() => {
                setShowExportDialog(true);
                loadExportStats();
              }}
              variant="outline"
              className="h-11 px-6 rounded-full flex-1"
            >
              <View className="flex-row items-center gap-2">
                <Download size={18} className="text-foreground" />
                <Text className="text-sm font-semibold text-foreground">
                  Export
                </Text>
              </View>
            </Button>

            <Button
              onPress={() => setShowImportDialog(true)}
              variant="outline"
              className="h-11 px-6 rounded-full flex-1"
            >
              <View className="flex-row items-center gap-2">
                <Upload size={18} className="text-foreground" />
                <Text className="text-sm font-semibold text-foreground">
                  Import
                </Text>
              </View>
            </Button>
          </View>
        </View>

        {/* Category Toggle Group */}
        {memories.length > 0 && (
          <View className="px-6 pb-4">
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

        {/* Memories Grid */}
        <View className="px-6 pb-6">
          {filteredMemories.length === 0 ? (
            <View className="items-center justify-center py-20">
              <Brain size={64} className="text-muted-foreground opacity-50" />
              <Text className="text-lg font-medium text-foreground mt-4">
                {memories.length === 0 ? 'No memories yet' : 'No memories found'}
              </Text>
              <Text className="text-sm text-muted-foreground text-center mt-2 max-w-md">
                {searchQuery
                  ? 'Try a different search term'
                  : 'Share personal information with Alia and it will be saved here automatically'
                }
              </Text>
            </View>
          ) : (
            <View className="flex-row flex-wrap gap-3">
              {filteredMemories.map((memory) => (
                <MemoryCard
                  key={memory._id}
                  memory={memory}
                  onEdit={() => handleOpenDialog(memory)}
                  onDelete={() => handleDeleteMemory(memory._id)}
                  getCategoryConfig={getCategoryConfig}
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
              {editingMemory ? 'Edit Memory' : 'New Memory'}
            </DialogTitle>
            <DialogDescription>
              {editingMemory
                ? 'Update the memory details below'
                : 'Add a new memory for Alia to remember'}
            </DialogDescription>
          </DialogHeader>

          <View className="gap-4">
            {/* Key Field */}
            <View className="gap-2">
              <Label nativeID="key">Key *</Label>
              <Input
                aria-labelledby="key"
                value={formKey}
                onChangeText={setFormKey}
                placeholder="e.g., favorite_food, pet_name"
                editable={!saving}
              />
            </View>

            {/* Value Field */}
            <View className="gap-2">
              <Label nativeID="value">Value *</Label>
              <Textarea
                aria-labelledby="value"
                value={formValue}
                onChangeText={setFormValue}
                placeholder="e.g., Pizza, Max"
                editable={!saving}
              />
            </View>

            {/* Category Field */}
            <View className="gap-2">
              <Label nativeID="category">Category</Label>
              <Input
                aria-labelledby="category"
                value={formCategory}
                onChangeText={setFormCategory}
                placeholder="e.g., preferencia, personal"
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
              <Text>Cancel</Text>
            </Button>
            <Button
              className="flex-1"
              onPress={handleSaveMemory}
              disabled={saving}
            >
              <Text>{saving ? 'Saving...' : editingMemory ? 'Update' : 'Add'}</Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Export Dialog */}
      <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
        <DialogContent closeButton={true}>
          <DialogHeader>
            <DialogTitle>Export Memory Data</DialogTitle>
            <DialogDescription>
              Download your memories, preferences, and context
            </DialogDescription>
          </DialogHeader>

          {exportStats && (
            <View className="gap-3">
              <View className="bg-muted rounded-lg p-3">
                <Text className="text-sm text-muted-foreground mb-2">Export Statistics</Text>
                <Text className="text-sm">Total Memories: {exportStats.totalMemories}</Text>
                <Text className="text-sm">Categories: {exportStats.totalCategories}</Text>
                <Text className="text-sm">
                  Size (JSON): ~{(exportStats.estimatedSizeJSON / 1024).toFixed(1)} KB
                </Text>
              </View>

              <View className="gap-2">
                <Label>Format</Label>
                <ToggleGroup
                  type="single"
                  value={exportFormat}
                  onValueChange={(val) => setExportFormat(val as 'json' | 'csv')}
                >
                  <ToggleGroupItem value="json">
                    <View className="flex-row items-center gap-2">
                      <FileJson size={16} className="text-foreground" />
                      <Text>JSON (Full)</Text>
                    </View>
                  </ToggleGroupItem>
                  <ToggleGroupItem value="csv">
                    <View className="flex-row items-center gap-2">
                      <FileText size={16} className="text-foreground" />
                      <Text>CSV</Text>
                    </View>
                  </ToggleGroupItem>
                </ToggleGroup>

                <Text className="text-xs text-muted-foreground mt-1">
                  {exportFormat === 'json'
                    ? 'Includes memories, preferences, and context'
                    : 'Memories only, compatible with spreadsheets'}
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
              <Text>Cancel</Text>
            </Button>
            <Button
              className="flex-1"
              onPress={() => handleExport(exportFormat)}
            >
              <View className="flex-row items-center gap-2">
                <Download size={16} className="text-primary-foreground" />
                <Text>Download {exportFormat.toUpperCase()}</Text>
              </View>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Dialog */}
      <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
        <DialogContent closeButton={true}>
          <DialogHeader>
            <DialogTitle>Import Memory Data</DialogTitle>
            <DialogDescription>
              Upload a JSON export file to restore or merge memories
            </DialogDescription>
          </DialogHeader>

          <View className="gap-4">
            {/* File Input */}
            <View className="gap-2">
              <Label>Select File</Label>
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
                <Text className="text-sm font-medium">Preview</Text>
                <Text className="text-xs">Total to import: {importPreview.totalToImport}</Text>
                <Text className="text-xs">New memories: {importPreview.newKeys}</Text>
                <Text className="text-xs">Duplicates: {importPreview.duplicateKeys}</Text>
                <Text className="text-xs">Final total: {importPreview.estimatedFinalTotal}</Text>
                {importPreview.memoryLimit !== -1 && (
                  <Text className="text-xs">Memory limit: {importPreview.memoryLimit}</Text>
                )}
              </View>
            )}

            {/* Strategy Selection */}
            {importFile && (
              <View className="gap-2">
                <Label>Import Strategy</Label>
                <ToggleGroup
                  type="single"
                  value={importStrategy}
                  onValueChange={(val) => setImportStrategy(val as any)}
                >
                  <ToggleGroupItem value="merge">
                    <Text>Merge</Text>
                  </ToggleGroupItem>
                  <ToggleGroupItem value="skip-duplicates">
                    <Text>Skip Dupes</Text>
                  </ToggleGroupItem>
                  <ToggleGroupItem value="replace">
                    <Text>Replace All</Text>
                  </ToggleGroupItem>
                </ToggleGroup>

                <Text className="text-xs text-muted-foreground mt-1">
                  {importStrategy === 'merge' && 'Update existing, add new memories'}
                  {importStrategy === 'skip-duplicates' && 'Only add new memories, skip existing'}
                  {importStrategy === 'replace' && '⚠️ Delete all existing and replace'}
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
              <Text>Cancel</Text>
            </Button>
            <Button
              className="flex-1"
              onPress={handleImport}
              disabled={!importFile || importing}
            >
              <Text>{importing ? 'Importing...' : 'Import'}</Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <ConfirmationDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        title="Delete Memory"
        description="Are you sure you want to delete this memory? This action cannot be undone."
        confirmText="Delete"
        cancelText="Cancel"
        confirmVariant="destructive"
        onConfirm={confirmDeleteMemory}
        loading={deleting}
      />
    </View>
  );
}

function MemoryCard({
  memory,
  onEdit,
  onDelete,
  getCategoryConfig,
}: {
  memory: Memory;
  onEdit: () => void;
  onDelete: () => void;
  getCategoryConfig: (category?: string) => { icon: any; color: string; bgColor: string };
}) {
  const config = getCategoryConfig(memory.category);
  const CategoryIcon = config.icon;

  return (
    <View className="w-[48%] md:w-[31%]">
      <Card className="overflow-hidden h-full">
        <View className="p-4">
          {/* Category Badge */}
          {memory.category && (
            <View className="flex-row items-center gap-1 mb-3">
              <View className={cn("px-2 py-1 rounded-full flex-row items-center gap-1", config.bgColor)}>
                <CategoryIcon size={10} className={config.color} />
                <Text className={cn("text-xs font-medium", config.color)}>
                  {memory.category}
                </Text>
              </View>
            </View>
          )}

          {/* Key */}
          <Text className="text-base font-semibold text-foreground mb-2" numberOfLines={1}>
            {memory.key}
          </Text>

          {/* Value */}
          <Text className="text-sm text-muted-foreground mb-3" numberOfLines={3}>
            {memory.value}
          </Text>

          {/* Date */}
          <View className="px-2 py-1 bg-muted rounded-md self-start mb-3">
            <Text className="text-xs text-muted-foreground">
              {memory.createdAt !== memory.updatedAt ? 'Updated' : 'Added'}{' '}
              {new Date(memory.updatedAt).toLocaleDateString()}
            </Text>
          </View>

          {/* Actions */}
          <View className="flex-row gap-2">
            <Pressable
              onPress={onEdit}
              className="flex-1 bg-primary/10 rounded-lg p-2 items-center active:opacity-70"
            >
              <Edit3 size={16} className="text-primary" />
            </Pressable>
            <Pressable
              onPress={onDelete}
              className="flex-1 bg-destructive/10 rounded-lg p-2 items-center active:opacity-70"
            >
              <Trash2 size={16} className="text-destructive" />
            </Pressable>
          </View>
        </View>
      </Card>
    </View>
  );
}

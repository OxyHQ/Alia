import React, { useState, useEffect, useMemo } from 'react';
import { View, ScrollView, Pressable, Alert } from "react-native";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAuthStore } from "@/lib/stores/auth-store";
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
} from "lucide-react-native";
import { useUserData } from "@/hooks/useUserData";
import { useUserDataStore } from "@/lib/stores/user-data-store";
import { cn } from "@/lib/utils";

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
  const { token, isAuthenticated } = useAuthStore();
  const { memory, loading } = useUserData();
  const setMemory = useUserDataStore((state) => state.setMemory);
  const [showDialog, setShowDialog] = useState(false);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [saving, setSaving] = useState(false);

  // Form state
  const [formKey, setFormKey] = useState("");
  const [formValue, setFormValue] = useState("");
  const [formCategory, setFormCategory] = useState("");

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
    if (!token || !formKey.trim() || !formValue.trim()) {
      Alert.alert("Error", "Key and value are required");
      return;
    }

    setSaving(true);
    try {
      if (editingMemory) {
        // Update existing memory
        const apiUrl = generateAPIUrl(`/api/memory/${editingMemory._id}`);
        const response = await fetch(apiUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
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
          Alert.alert("Success", "Memory updated successfully");
        }
      } else {
        // Add new memory
        const apiUrl = generateAPIUrl('/api/memory/add');
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
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
          Alert.alert("Success", "Memory added successfully");
        }
      }
    } catch (error) {
      console.error("Error saving memory:", error);
      Alert.alert("Error", "Failed to save memory");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteMemory = async (memoryId: string) => {
    if (!token) return;

    Alert.alert(
      "Delete Memory",
      "Are you sure you want to delete this memory?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const apiUrl = generateAPIUrl(`/api/memory/${memoryId}`);
              const response = await fetch(apiUrl, {
                method: 'DELETE',
                headers: {
                  'Authorization': `Bearer ${token}`,
                },
              });

              if (response.ok) {
                const updatedMemory = await response.json();
                setMemory(updatedMemory);
                Alert.alert("Success", "Memory deleted successfully");
              }
            } catch (error) {
              console.error("Error deleting memory:", error);
              Alert.alert("Error", "Failed to delete memory");
            }
          },
        },
      ]
    );
  };

  const getCategoryConfig = (category?: string) => {
    const cat = (category || 'default').toLowerCase();
    return CATEGORY_CONFIG[cat] || CATEGORY_CONFIG.default;
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
              placeholderTextColor="#6b7280"
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

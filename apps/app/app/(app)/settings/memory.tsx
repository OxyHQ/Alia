import { View, ScrollView, TextInput as RNTextInput, Pressable, Alert } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import { useAuthStore } from "@/lib/stores/auth-store";
import { useRouter } from "expo-router";
import { generateAPIUrl } from "@/lib/generate-api-url";
import { Brain, Plus, Trash2, ArrowLeft } from "lucide-react-native";
import { useUserData } from "@/hooks/useUserData";
import { useUserDataStore } from "@/lib/stores/user-data-store";

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

export default function MemoryScreen() {
  const router = useRouter();
  const { token, isAuthenticated } = useAuthStore();
  const { memory, loading } = useUserData();
  const setMemory = useUserDataStore((state) => state.setMemory);
  const [showAddForm, setShowAddForm] = useState(false);

  // Form state for adding new memory
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newCategory, setNewCategory] = useState("");

  const memories = memory?.memories || [];

  // Redirect if not authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated]);

  const handleAddMemory = async () => {
    if (!token || !newKey.trim() || !newValue.trim()) {
      Alert.alert("Error", "Key and value are required");
      return;
    }

    try {
      const apiUrl = generateAPIUrl('/api/memory/add');
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          key: newKey,
          value: newValue,
          category: newCategory || undefined,
        }),
      });

      if (response.ok) {
        const updatedMemory = await response.json();
        setMemory(updatedMemory);
        setNewKey("");
        setNewValue("");
        setNewCategory("");
        setShowAddForm(false);
      }
    } catch (error) {
      console.error("Error adding memory:", error);
      Alert.alert("Error", "Failed to add memory");
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

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Text>Loading...</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <View className="border-b border-border p-4">
        <View className="flex-row items-center gap-3">
          <Pressable onPress={() => router.back()}>
            <ArrowLeft size={24} className="text-foreground" />
          </Pressable>
          <View className="flex-1">
            <Text className="text-2xl font-bold">Memory Management</Text>
            <Text className="text-sm text-muted-foreground mt-1">
              Manage what Alia remembers about you
            </Text>
          </View>
        </View>
      </View>

      <ScrollView className="flex-1 p-4">
        <View className="max-w-2xl mx-auto w-full gap-4">
          {/* Add Memory Button */}
          {!showAddForm && (
            <Button
              onPress={() => setShowAddForm(true)}
              className="flex-row items-center justify-center gap-2"
            >
              <Plus size={20} className="text-primary-foreground" />
              <Text className="text-primary-foreground">Add New Memory</Text>
            </Button>
          )}

          {/* Add Memory Form */}
          {showAddForm && (
            <View className="border border-border rounded-lg p-4 gap-3 bg-muted/30">
              <Text className="text-lg font-semibold">New Memory</Text>

              <View className="gap-2">
                <Text className="text-sm font-medium">Key</Text>
                <RNTextInput
                  className="border border-border rounded-lg px-4 py-3 bg-background text-foreground"
                  placeholder="e.g., favorite food, pet name"
                  value={newKey}
                  onChangeText={setNewKey}
                />
              </View>

              <View className="gap-2">
                <Text className="text-sm font-medium">Value</Text>
                <RNTextInput
                  className="border border-border rounded-lg px-4 py-3 bg-background text-foreground"
                  placeholder="e.g., Pizza, Max"
                  value={newValue}
                  onChangeText={setNewValue}
                  multiline
                />
              </View>

              <View className="gap-2">
                <Text className="text-sm font-medium">Category (optional)</Text>
                <RNTextInput
                  className="border border-border rounded-lg px-4 py-3 bg-background text-foreground"
                  placeholder="e.g., personal, work, hobbies"
                  value={newCategory}
                  onChangeText={setNewCategory}
                />
              </View>

              <View className="flex-row gap-2 mt-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onPress={() => {
                    setShowAddForm(false);
                    setNewKey("");
                    setNewValue("");
                    setNewCategory("");
                  }}
                >
                  <Text>Cancel</Text>
                </Button>
                <Button
                  className="flex-1"
                  onPress={handleAddMemory}
                >
                  <Text>Add Memory</Text>
                </Button>
              </View>
            </View>
          )}

          {/* Memories List */}
          {memories.length === 0 ? (
            <View className="items-center justify-center py-12">
              <Brain size={48} className="text-muted-foreground mb-4" />
              <Text className="text-lg text-muted-foreground text-center">
                No memories yet
              </Text>
              <Text className="text-sm text-muted-foreground text-center mt-2">
                Add memories to help Alia personalize responses
              </Text>
            </View>
          ) : (
            <View className="gap-3">
              <Text className="text-sm text-muted-foreground">
                {memories.length} {memories.length === 1 ? 'memory' : 'memories'}
              </Text>
              {memories.map((memory) => (
                <View
                  key={memory._id}
                  className="border border-border rounded-lg p-4 bg-card"
                >
                  <View className="flex-row items-start justify-between gap-3">
                    <View className="flex-1">
                      <View className="flex-row items-center gap-2 mb-1">
                        <Text className="text-base font-semibold text-foreground">
                          {memory.key}
                        </Text>
                        {memory.category && (
                          <View className="bg-primary/10 px-2 py-0.5 rounded">
                            <Text className="text-xs text-primary">
                              {memory.category}
                            </Text>
                          </View>
                        )}
                      </View>
                      <Text className="text-sm text-muted-foreground">
                        {memory.value}
                      </Text>
                      <Text className="text-xs text-muted-foreground mt-2">
                        Added {new Date(memory.createdAt).toLocaleDateString()}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => handleDeleteMemory(memory._id)}
                      className="p-2 rounded-lg active:bg-muted"
                    >
                      <Trash2 size={18} className="text-destructive" />
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

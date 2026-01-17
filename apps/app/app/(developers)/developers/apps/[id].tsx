import { View, ScrollView, Pressable, Alert, TextInput as RNTextInput } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useState, useEffect } from "react";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ArrowLeft, Package, Key, Plus, Copy, Trash2, Eye, EyeOff, Edit, Activity } from "lucide-react-native";
import { useDeveloperStore, type DeveloperApiKey } from "@/lib/stores/developer-store";
import * as Clipboard from 'expo-clipboard';

export default function AppDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const {
    currentApp,
    apiKeys,
    isLoadingKeys,
    fetchApp,
    fetchApiKeys,
    deleteApp,
    createApiKey,
    deleteApiKey,
  } = useDeveloperStore();

  const [showNewKeyModal, setShowNewKeyModal] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [creatingKey, setCreatingKey] = useState(false);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);

  useEffect(() => {
    if (id) {
      fetchApp(id).catch(console.error);
      fetchApiKeys(id).catch(console.error);
    }
  }, [id]);

  const handleDeleteApp = () => {
    Alert.alert(
      "Delete App",
      "Are you sure you want to delete this app? This will also delete all API keys and usage data.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteApp(id!);
              router.replace("/developers");
            } catch (error: any) {
              Alert.alert("Error", error.message || "Failed to delete app");
            }
          },
        },
      ]
    );
  };

  const handleCreateKey = async () => {
    if (!keyName.trim()) {
      Alert.alert("Error", "Please enter a key name");
      return;
    }

    setCreatingKey(true);
    try {
      const newKey = await createApiKey(id!, {
        name: keyName.trim(),
        scopes: ["chat:read", "chat:write", "models:read"],
      });

      setNewlyCreatedKey(newKey.key || null);
      setShowNewKeyModal(false);
      setKeyName("");
    } catch (error: any) {
      Alert.alert("Error", error.message || "Failed to create API key");
    } finally {
      setCreatingKey(false);
    }
  };

  const handleDeleteKey = (keyId: string, keyName: string) => {
    Alert.alert(
      "Delete API Key",
      `Are you sure you want to delete "${keyName}"? This action cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteApiKey(id!, keyId);
              Alert.alert("Success", "API key deleted");
            } catch (error: any) {
              Alert.alert("Error", error.message || "Failed to delete API key");
            }
          },
        },
      ]
    );
  };

  const handleCopyKey = async (key: string) => {
    await Clipboard.setStringAsync(key);
    Alert.alert("Copied", "API key copied to clipboard");
  };

  if (!currentApp) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-muted-foreground">Loading...</Text>
      </View>
    );
  }

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-6 py-4 border-b border-border">
        <Pressable onPress={() => router.back()} className="flex-row items-center mb-4">
          <ArrowLeft size={20} className="text-muted-foreground mr-2" />
          <Text className="text-base text-muted-foreground">Back</Text>
        </Pressable>

        <View className="flex-row items-start">
          <View className="w-14 h-14 rounded-2xl bg-primary/10 items-center justify-center mr-4">
            <Package size={28} className="text-primary" />
          </View>
          <View className="flex-1">
            <Text className="text-3xl font-bold text-foreground">{currentApp.name}</Text>
            {currentApp.description && (
              <Text className="text-base text-muted-foreground mt-1">
                {currentApp.description}
              </Text>
            )}
            <View className="flex-row items-center mt-2">
              {currentApp.isActive ? (
                <View className="px-2 py-1 rounded-full bg-green-500/10 mr-2">
                  <Text className="text-xs font-medium text-green-600">Active</Text>
                </View>
              ) : (
                <View className="px-2 py-1 rounded-full bg-gray-500/10 mr-2">
                  <Text className="text-xs font-medium text-gray-600">Inactive</Text>
                </View>
              )}
              <Text className="text-xs text-muted-foreground">
                Created {new Date(currentApp.createdAt).toLocaleDateString()}
              </Text>
            </View>
          </View>
        </View>
      </View>

      {/* App Info */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-lg font-semibold text-foreground mb-4">App Information</Text>
        <Card className="p-4">
          <View className="mb-3">
            <Text className="text-xs font-semibold text-muted-foreground mb-1">App ID</Text>
            <Text className="text-sm text-foreground font-mono">{currentApp._id}</Text>
          </View>
          {currentApp.websiteUrl && (
            <View>
              <Text className="text-xs font-semibold text-muted-foreground mb-1">Website</Text>
              <Text className="text-sm text-primary">{currentApp.websiteUrl}</Text>
            </View>
          )}
        </Card>
      </View>

      {/* API Keys Section */}
      <View className="px-6 py-6 border-b border-border">
        <View className="flex-row items-center justify-between mb-4">
          <Text className="text-lg font-semibold text-foreground">API Keys</Text>
          <Button
            onPress={() => setShowNewKeyModal(true)}
            size="sm"
          >
            <Plus size={16} className="text-primary-foreground mr-1" />
            <Text className="text-primary-foreground font-semibold text-sm">New Key</Text>
          </Button>
        </View>

        {/* New Key Modal */}
        {showNewKeyModal && (
          <Card className="p-4 mb-4 bg-muted">
            <Text className="text-base font-semibold text-foreground mb-3">Create API Key</Text>
            <RNTextInput
              value={keyName}
              onChangeText={setKeyName}
              placeholder="Key name (e.g., Production)"
              className="w-full px-4 py-3 rounded-xl border border-border bg-background text-foreground mb-3"
              placeholderTextColor="#9CA3AF"
              maxLength={100}
            />
            <View className="flex-row space-x-2">
              <Button
                variant="outline"
                onPress={() => {
                  setShowNewKeyModal(false);
                  setKeyName("");
                }}
                className="flex-1"
              >
                <Text className="text-foreground">Cancel</Text>
              </Button>
              <Button
                onPress={handleCreateKey}
                className="flex-1"
                disabled={creatingKey || !keyName.trim()}
              >
                <Text className="text-primary-foreground font-semibold">
                  {creatingKey ? "Creating..." : "Create"}
                </Text>
              </Button>
            </View>
          </Card>
        )}

        {/* Newly Created Key Alert */}
        {newlyCreatedKey && (
          <Card className="p-4 mb-4 bg-yellow-50 border-yellow-200">
            <Text className="text-sm font-semibold text-yellow-900 mb-2">
              Save your API key!
            </Text>
            <Text className="text-xs text-yellow-800 mb-3">
              This is the only time you'll see this key. Copy it now and store it securely.
            </Text>
            <Pressable
              onPress={() => handleCopyKey(newlyCreatedKey)}
              className="flex-row items-center p-3 rounded-lg bg-yellow-100 mb-3"
            >
              <Text className="flex-1 text-sm font-mono text-yellow-900" numberOfLines={1}>
                {newlyCreatedKey}
              </Text>
              <Copy size={16} className="text-yellow-900 ml-2" />
            </Pressable>
            <Button
              onPress={() => setNewlyCreatedKey(null)}
              size="sm"
              variant="outline"
            >
              <Text className="text-foreground">I've saved my key</Text>
            </Button>
          </Card>
        )}

        {/* API Keys List */}
        {isLoadingKeys ? (
          <View className="py-8">
            <Text className="text-center text-muted-foreground">Loading keys...</Text>
          </View>
        ) : apiKeys.length === 0 ? (
          <Card className="p-8">
            <View className="items-center">
              <Key size={32} className="text-muted-foreground mb-2" />
              <Text className="text-base text-muted-foreground text-center">
                No API keys yet. Create one to get started.
              </Text>
            </View>
          </Card>
        ) : (
          <View className="space-y-3">
            {apiKeys.map((key) => (
              <Card key={key._id} className="p-4">
                <View className="flex-row items-start justify-between mb-2">
                  <View className="flex-1">
                    <Text className="text-base font-semibold text-foreground mb-1">
                      {key.name}
                    </Text>
                    <Text className="text-xs font-mono text-muted-foreground mb-2">
                      {key.keyPrefix}...
                    </Text>
                  </View>
                  {key.isActive ? (
                    <View className="px-2 py-1 rounded-full bg-green-500/10">
                      <Text className="text-xs font-medium text-green-600">Active</Text>
                    </View>
                  ) : (
                    <View className="px-2 py-1 rounded-full bg-gray-500/10">
                      <Text className="text-xs font-medium text-gray-600">Inactive</Text>
                    </View>
                  )}
                </View>

                <View className="flex-row flex-wrap mb-2">
                  {key.scopes.map((scope) => (
                    <View key={scope} className="px-2 py-1 rounded-full bg-primary/10 mr-2 mb-1">
                      <Text className="text-xs text-primary">{scope}</Text>
                    </View>
                  ))}
                </View>

                <View className="flex-row items-center justify-between">
                  <Text className="text-xs text-muted-foreground">
                    Created {new Date(key.createdAt).toLocaleDateString()}
                    {key.lastUsedAt && ` • Last used ${new Date(key.lastUsedAt).toLocaleDateString()}`}
                  </Text>
                  <Pressable
                    onPress={() => handleDeleteKey(key._id, key.name)}
                    className="p-2"
                  >
                    <Trash2 size={16} className="text-destructive" />
                  </Pressable>
                </View>
              </Card>
            ))}
          </View>
        )}
      </View>

      {/* Usage Stats Link */}
      <View className="px-6 py-6 border-b border-border">
        <Pressable
          onPress={() => router.push(`/developers/apps/${id}/usage`)}
          className="active:opacity-70"
        >
          <Card className="p-4">
            <View className="flex-row items-center">
              <Activity size={20} className="text-primary mr-3" />
              <View className="flex-1">
                <Text className="text-base font-semibold text-foreground">View Usage Statistics</Text>
                <Text className="text-sm text-muted-foreground">
                  See detailed analytics and API usage
                </Text>
              </View>
            </View>
          </Card>
        </Pressable>
      </View>

      {/* Danger Zone */}
      <View className="px-6 py-6">
        <Text className="text-lg font-semibold text-destructive mb-4">Danger Zone</Text>
        <Card className="p-4 border-destructive">
          <Button
            variant="destructive"
            onPress={handleDeleteApp}
          >
            <Trash2 size={18} className="text-destructive-foreground mr-2" />
            <Text className="text-destructive-foreground font-semibold">Delete App</Text>
          </Button>
        </Card>
      </View>
    </ScrollView>
  );
}

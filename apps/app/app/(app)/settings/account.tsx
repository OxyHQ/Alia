import { View, ScrollView, TextInput as RNTextInput, Pressable, Alert, Image as RNImage, ActivityIndicator, Platform } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useState } from "react";
import { useOxy } from "@oxyhq/services";
import { useRouter } from "expo-router";
import { generateAPIUrl } from "@/lib/generate-api-url";
import { User, Mail, Lock, ArrowLeft, LogOut, Camera, Trash2 } from "lucide-react-native";
import { useImagePicker } from "@/hooks/useImagePicker";
import { toast } from "@/components/sonner";

export default function AccountScreen() {
  const router = useRouter();
  const { user, activeSessionId, logout } = useOxy();
  const [changingPassword, setChangingPassword] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const { pickImage } = useImagePicker();

  // Password change form
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const getUserInitials = () => {
    if (!user?.name) return "U";
    const names = user.name.split(" ");
    if (names.length >= 2) {
      return `${names[0][0]}${names[1][0]}`.toUpperCase();
    }
    return names[0][0].toUpperCase();
  };

  const handleLogout = () => {
    Alert.alert(
      "Logout",
      "Are you sure you want to logout?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Logout",
          style: "destructive",
          onPress: () => {
            logout();
            router.replace("/login");
          },
        },
      ]
    );
  };

  const handleUploadAvatar = async () => {
    try {
      const imageUris = await pickImage();
      if (!imageUris || imageUris.length === 0) return;

      setUploadingAvatar(true);
      const imageUri = imageUris[0];

      // Create FormData
      const formData = new FormData();
      const filename = imageUri.split('/').pop() || 'avatar.jpg';
      const match = /\.(\w+)$/.exec(filename);
      const type = match ? `image/${match[1]}` : 'image/jpeg';

      if (Platform.OS === 'web') {
        // For web, fetch the blob and create a File object
        const response = await fetch(imageUri);
        const blob = await response.blob();
        const file = new File([blob], filename, { type });
        formData.append('avatar', file);
      } else {
        // For native, use the uri/name/type format
        formData.append('avatar', {
          uri: imageUri,
          name: filename,
          type,
        } as any);
      }

      const apiUrl = generateAPIUrl('/upload/avatar');
      const uploadResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        body: formData,
      });

      if (uploadResponse.ok) {
        const data = await uploadResponse.json();
        updateUser({ image: data.avatarUrl });
        toast.success("Avatar uploaded successfully");
      } else {
        const error = await uploadResponse.json();
        toast.error(error.error || "Failed to upload avatar");
      }
    } catch (error) {
      console.error("Error uploading avatar:", error);
      toast.error("Failed to upload avatar");
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleDeleteAvatar = async () => {
    Alert.alert(
      "Delete Avatar",
      "Are you sure you want to delete your avatar?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const apiUrl = generateAPIUrl('/upload/avatar');
              const response = await fetch(apiUrl, {
                method: 'DELETE',
                headers: {
                  'Authorization': `Bearer ${token}`,
                },
              });

              if (response.ok) {
                updateUser({ image: undefined });
                toast.success("Avatar deleted successfully");
              } else {
                toast.error("Failed to delete avatar");
              }
            } catch (error) {
              console.error("Error deleting avatar:", error);
              toast.error("Failed to delete avatar");
            }
          },
        },
      ]
    );
  };

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      toast.error("All fields are required");
      return;
    }

    if (newPassword !== confirmPassword) {
      toast.error("New passwords do not match");
      return;
    }

    if (newPassword.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }

    try {
      // TODO: Implement change password API
      toast.success("Password changed successfully");
      setChangingPassword(false);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error) {
      console.error("Error changing password:", error);
      toast.error("Failed to change password");
    }
  };

  return (
    <View className="flex-1 bg-background">
      <View className="border-b border-border p-4">
        <View className="flex-row items-center gap-3">
          <Pressable onPress={() => router.back()}>
            <ArrowLeft size={24} className="text-foreground" />
          </Pressable>
          <View className="flex-1">
            <Text className="text-2xl font-bold">Account Settings</Text>
            <Text className="text-sm text-muted-foreground mt-1">
              Manage your account information
            </Text>
          </View>
        </View>
      </View>

      <ScrollView className="flex-1 p-4">
        <View className="max-w-2xl mx-auto w-full gap-6">
          {/* Avatar Section */}
          <View className="gap-4">
            <Text className="text-lg font-semibold">Profile Picture</Text>
            <View className="flex-row items-center gap-4">
              <Avatar className="h-24 w-24">
                {user?.image ? (
                  <AvatarImage source={{ uri: user.image }} />
                ) : null}
                <AvatarFallback className="bg-primary">
                  <Text className="text-2xl text-primary-foreground">{getUserInitials()}</Text>
                </AvatarFallback>
              </Avatar>
              <View className="flex-1 gap-2">
                <Button
                  variant="outline"
                  className="flex-row items-center justify-center gap-2"
                  onPress={handleUploadAvatar}
                  disabled={uploadingAvatar}
                >
                  {uploadingAvatar ? (
                    <ActivityIndicator size="small" />
                  ) : (
                    <Camera size={16} className="text-foreground" />
                  )}
                  <Text>{uploadingAvatar ? "Uploading..." : "Upload Avatar"}</Text>
                </Button>
                {user?.image && (
                  <Button
                    variant="outline"
                    className="flex-row items-center justify-center gap-2 border-destructive"
                    onPress={handleDeleteAvatar}
                    disabled={uploadingAvatar}
                  >
                    <Trash2 size={16} className="text-destructive" />
                    <Text className="text-destructive">Remove Avatar</Text>
                  </Button>
                )}
              </View>
            </View>
            <Text className="text-xs text-muted-foreground">
              Recommended: Square image, at least 200x200px, max 5MB
            </Text>
          </View>

          {/* Account Information */}
          <View className="gap-4">
            <Text className="text-lg font-semibold">Account Information</Text>

            <View className="gap-2">
              <View className="flex-row items-center gap-2">
                <User size={20} className="text-primary" />
                <Text className="text-base font-semibold">Name</Text>
              </View>
              <View className="border border-border rounded-lg px-4 py-3 bg-muted">
                <Text className="text-foreground">
                  {user?.name || "Not set"}
                </Text>
              </View>
            </View>

            <View className="gap-2">
              <View className="flex-row items-center gap-2">
                <Mail size={20} className="text-primary" />
                <Text className="text-base font-semibold">Email</Text>
              </View>
              <View className="border border-border rounded-lg px-4 py-3 bg-muted">
                <Text className="text-foreground">
                  {user?.email}
                </Text>
              </View>
              <Text className="text-xs text-muted-foreground">
                Email cannot be changed
              </Text>
            </View>
          </View>

          {/* Password Section */}
          <View className="gap-4">
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center gap-2">
                <Lock size={20} className="text-primary" />
                <Text className="text-lg font-semibold">Password</Text>
              </View>
              {!changingPassword && (
                <Button
                  variant="outline"
                  size="sm"
                  onPress={() => setChangingPassword(true)}
                >
                  <Text>Change Password</Text>
                </Button>
              )}
            </View>

            {changingPassword && (
              <View className="border border-border rounded-lg p-4 gap-3 bg-muted/30">
                <View className="gap-2">
                  <Text className="text-sm font-medium">Current Password</Text>
                  <RNTextInput
                    className="border border-border rounded-lg px-4 py-3 bg-background text-foreground"
                    placeholder="Enter current password"
                    value={currentPassword}
                    onChangeText={setCurrentPassword}
                    secureTextEntry
                  />
                </View>

                <View className="gap-2">
                  <Text className="text-sm font-medium">New Password</Text>
                  <RNTextInput
                    className="border border-border rounded-lg px-4 py-3 bg-background text-foreground"
                    placeholder="Enter new password"
                    value={newPassword}
                    onChangeText={setNewPassword}
                    secureTextEntry
                  />
                  <Text className="text-xs text-muted-foreground">
                    Must be at least 8 characters
                  </Text>
                </View>

                <View className="gap-2">
                  <Text className="text-sm font-medium">Confirm New Password</Text>
                  <RNTextInput
                    className="border border-border rounded-lg px-4 py-3 bg-background text-foreground"
                    placeholder="Confirm new password"
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    secureTextEntry
                  />
                </View>

                <View className="flex-row gap-2 mt-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onPress={() => {
                      setChangingPassword(false);
                      setCurrentPassword("");
                      setNewPassword("");
                      setConfirmPassword("");
                    }}
                  >
                    <Text>Cancel</Text>
                  </Button>
                  <Button
                    className="flex-1"
                    onPress={handleChangePassword}
                  >
                    <Text>Update Password</Text>
                  </Button>
                </View>
              </View>
            )}
          </View>

          {/* Danger Zone */}
          <View className="gap-4 border-t border-border pt-6">
            <Text className="text-lg font-semibold text-destructive">Danger Zone</Text>

            <View className="gap-3">
              <Button
                variant="outline"
                className="flex-row items-center justify-center gap-2 border-destructive"
                onPress={handleLogout}
              >
                <LogOut size={20} className="text-destructive" />
                <Text className="text-destructive">Logout</Text>
              </Button>
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

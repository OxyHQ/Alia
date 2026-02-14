import { View, Pressable, Linking } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useRouter } from "expo-router";
import { useOxy } from "@oxyhq/services";
import { generateAPIUrl } from "@/lib/generate-api-url";
import { useTelegramStatus } from "@/hooks/useTelegramStatus";
import { useGatewaySessions } from "@/hooks/useGatewaySessions";
import { useTranslation } from "@/hooks/useTranslation";
import { toast } from "@/components/sonner";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { Send, Smartphone, Shield, ChevronRight } from "lucide-react-native";

export function ConnectorsSection() {
  const router = useRouter();
  const { isAuthenticated, oxyServices } = useOxy();
  const { t } = useTranslation();
  const {
    status: telegramStatus,
    loading: telegramLoading,
    refresh: refreshTelegram,
  } = useTelegramStatus();
  const { connectedCount: whatsappCount, loading: whatsappLoading } =
    useGatewaySessions("whatsapp");
  const { connectedCount: telegramGwCount, loading: telegramGwLoading } =
    useGatewaySessions("telegram-gateway");
  const { connectedCount: signalGwCount, loading: signalGwLoading } =
    useGatewaySessions("signal-gateway");

  const [showUnlinkDialog, setShowUnlinkDialog] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const handleUnlinkTelegram = async () => {
    if (!isAuthenticated) return;

    setUnlinking(true);
    try {
      const token = oxyServices.getAccessToken();
      const apiUrl = generateAPIUrl("/telegram/unlink");
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (response.ok) {
        toast.success("Telegram unlinked successfully");
        await refreshTelegram();
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to unlink Telegram");
      }
    } catch (err) {
      console.error("Failed to unlink Telegram:", err);
      toast.error("Failed to unlink Telegram");
    } finally {
      setUnlinking(false);
    }
  };

  const handleTelegramPress = async () => {
    if (telegramStatus?.linked) {
      setShowUnlinkDialog(true);
      return;
    }
    const botUsername =
      process.env.EXPO_PUBLIC_TELEGRAM_BOT_USERNAME || "alia_onlbot";
    const linkUrl = `https://t.me/${botUsername}?start=link`;
    try {
      const canOpen = await Linking.canOpenURL(linkUrl);
      if (canOpen) {
        await Linking.openURL(linkUrl);
      } else {
        toast.error("Cannot open Telegram");
      }
    } catch (err) {
      console.error("Failed to open Telegram:", err);
      toast.error("Failed to open Telegram");
    }
  };

  return (
    <View className="gap-1">
      <Text className="text-xs text-muted-foreground mb-2">
        {t("settings.connectors.subtitle")}
      </Text>

      {/* Telegram Bot */}
      <Pressable
        onPress={handleTelegramPress}
        className="flex-row items-center py-3 px-1 active:bg-muted/50 rounded-lg"
      >
        <View className="bg-[#0088CC]/10 p-1.5 rounded-lg mr-3">
          <Send size={18} color="#0088CC" />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-medium">
            {telegramLoading
              ? "Telegram"
              : telegramStatus?.linked
                ? "Telegram Linked"
                : "Link Telegram"}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {telegramLoading
              ? "Checking..."
              : telegramStatus?.linked
                ? `Connected${telegramStatus.telegramUsername ? ` as @${telegramStatus.telegramUsername}` : ""}`
                : "Connect your Telegram account"}
          </Text>
        </View>
        {telegramStatus?.linked ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onPress={(e) => {
              e.stopPropagation();
              setShowUnlinkDialog(true);
            }}
          >
            <Text className="text-destructive text-xs">Unlink</Text>
          </Button>
        ) : (
          <ChevronRight size={16} className="text-muted-foreground" />
        )}
      </Pressable>

      {/* WhatsApp */}
      <Pressable
        onPress={() => router.push("/(app)/settings/whatsapp")}
        className="flex-row items-center py-3 px-1 active:bg-muted/50 rounded-lg"
      >
        <View className="bg-[#25D366]/10 p-1.5 rounded-lg mr-3">
          <Smartphone size={18} color="#25D366" />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-medium">
            {whatsappLoading
              ? "WhatsApp"
              : whatsappCount > 0
                ? `WhatsApp (${whatsappCount})`
                : "WhatsApp"}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {whatsappLoading
              ? "Checking..."
              : whatsappCount > 0
                ? "Alia responds as you"
                : "Link your WhatsApp account"}
          </Text>
        </View>
        <ChevronRight size={16} className="text-muted-foreground" />
      </Pressable>

      {/* Telegram Gateway */}
      <Pressable
        onPress={() => router.push("/(app)/settings/telegram-gateway")}
        className="flex-row items-center py-3 px-1 active:bg-muted/50 rounded-lg"
      >
        <View className="bg-[#0088CC]/10 p-1.5 rounded-lg mr-3">
          <Send size={18} color="#0088CC" />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-medium">
            {telegramGwLoading
              ? "Telegram Gateway"
              : telegramGwCount > 0
                ? `Telegram Gateway (${telegramGwCount})`
                : "Telegram Gateway"}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {telegramGwLoading
              ? "Checking..."
              : telegramGwCount > 0
                ? "Alia responds as you"
                : "Link your Telegram account"}
          </Text>
        </View>
        <ChevronRight size={16} className="text-muted-foreground" />
      </Pressable>

      {/* Signal Gateway */}
      <Pressable
        onPress={() => router.push("/(app)/settings/signal-gateway")}
        className="flex-row items-center py-3 px-1 active:bg-muted/50 rounded-lg"
      >
        <View className="bg-[#3A76F0]/10 p-1.5 rounded-lg mr-3">
          <Shield size={18} color="#3A76F0" />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-medium">
            {signalGwLoading
              ? "Signal"
              : signalGwCount > 0
                ? `Signal (${signalGwCount})`
                : "Signal"}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {signalGwLoading
              ? "Checking..."
              : signalGwCount > 0
                ? "Alia responds as you"
                : "Link your Signal account"}
          </Text>
        </View>
        <ChevronRight size={16} className="text-muted-foreground" />
      </Pressable>

      {/* Telegram Unlink Dialog */}
      <ConfirmationDialog
        open={showUnlinkDialog}
        onOpenChange={setShowUnlinkDialog}
        title="Unlink Telegram"
        description="Are you sure you want to unlink your Telegram account? You can link it again anytime."
        confirmText="Unlink"
        cancelText="Cancel"
        confirmVariant="destructive"
        onConfirm={handleUnlinkTelegram}
        loading={unlinking}
      />
    </View>
  );
}

import React from "react";
import { View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { Text } from "@/components/ui/text";
import { GetAppIcon } from "@/components/ui/get-app-icon";
import { Dialog } from "@oxyhq/bloom/dialog";
import { useColorScheme } from "@/lib/useColorScheme";

const DOWNLOAD_URL = "https://alia.onl/download";

interface AppDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AppDownloadDialog({ open, onOpenChange }: AppDownloadDialogProps) {
  const { colors } = useColorScheme();

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      placement={{ base: "bottom", md: "center" }}
      title="Get the app"
      description="Scan this QR code with your phone to download Alia."
      maxWidth={384}
    >
        {/* Header Icon */}
        <View className="items-center mb-4">
          <View className="h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <GetAppIcon size={32} color={colors.primary} />
          </View>
        </View>

        {/* QR Code */}
        <View className="items-center">
          <View className="bg-white p-4 rounded-2xl">
            <QRCode
              value={DOWNLOAD_URL}
              size={200}
              backgroundColor="white"
              color="black"
            />
          </View>
        </View>

        <Text className="text-xs text-muted-foreground text-center mt-2">
          Point your phone camera at the code
        </Text>
    </Dialog>
  );
}

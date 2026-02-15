import React from "react";
import { View } from "react-native";
import { Smartphone } from "lucide-react-native";
import QRCode from "react-native-qrcode-svg";
import { Text } from "@/components/ui/text";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const DOWNLOAD_URL = "https://alia.onl/download";

interface AppDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AppDownloadDialog({ open, onOpenChange }: AppDownloadDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {/* Header Icon */}
        <View className="items-center mb-4">
          <View className="h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <Smartphone size={32} className="text-primary" />
          </View>
        </View>

        <DialogHeader className="items-center">
          <DialogTitle className="text-xl text-center">
            Get the app
          </DialogTitle>
          <DialogDescription className="text-center">
            Scan this QR code with your phone to download Alia.
          </DialogDescription>
        </DialogHeader>

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
          Available on iOS and Android
        </Text>
      </DialogContent>
    </Dialog>
  );
}

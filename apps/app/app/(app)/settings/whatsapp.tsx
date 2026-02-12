import { View, Pressable, ActivityIndicator } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import { useRouter } from "expo-router";
import { useWhatsAppStatus } from "@/hooks/useWhatsAppStatus";
import { ChevronLeft, Smartphone, CheckCircle, XCircle, RefreshCw } from "lucide-react-native";
import { toast } from "@/components/sonner";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import QRCode from "react-native-qrcode-svg";

export default function WhatsAppSetupScreen() {
  const router = useRouter();
  const [polling, setPolling] = useState(false);
  const { status, loading, connect, disconnect, refresh } = useWhatsAppStatus(polling);
  const [connecting, setConnecting] = useState(false);
  const [qrData, setQrData] = useState<string | null>(null);
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const isConnected = status?.status === 'connected';
  const isQrPending = status?.status === 'qr-pending';

  // Start polling when QR is pending
  useEffect(() => {
    if (isQrPending || connecting) {
      setPolling(true);
    } else {
      setPolling(false);
    }
  }, [isQrPending, connecting]);

  // Update QR data from status
  useEffect(() => {
    if (status?.lastQR) {
      setQrData(status.lastQR);
    }
    if (isConnected) {
      setConnecting(false);
      setQrData(null);
    }
  }, [status, isConnected]);

  const handleConnect = async () => {
    try {
      setConnecting(true);
      const data = await connect();
      if (data?.qr) {
        setQrData(data.qr);
      }
    } catch (err) {
      toast.error("Failed to start WhatsApp connection");
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      setDisconnecting(true);
      await disconnect();
      toast.success("WhatsApp disconnected");
      setQrData(null);
    } catch (err) {
      toast.error("Failed to disconnect WhatsApp");
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="border-b border-border p-4 flex-row items-center gap-3">
        <Pressable onPress={() => router.back()} className="p-1">
          <ChevronLeft size={24} className="text-foreground" />
        </Pressable>
        <View>
          <Text className="text-xl font-bold">Connect WhatsApp</Text>
          <Text className="text-sm text-muted-foreground">
            Link your WhatsApp to chat with Alia
          </Text>
        </View>
      </View>

      <View className="flex-1 p-6 items-center justify-center">
        <View className="max-w-sm w-full gap-6 items-center">
          {loading && !connecting ? (
            <ActivityIndicator size="large" />
          ) : isConnected ? (
            /* Connected State */
            <View className="items-center gap-4 w-full">
              <View className="bg-green-500/10 p-6 rounded-full">
                <CheckCircle size={48} className="text-green-500" />
              </View>
              <Text className="text-xl font-bold text-center">WhatsApp Connected</Text>
              {status?.phoneNumber && (
                <Text className="text-muted-foreground text-center">
                  Phone: +{status.phoneNumber}
                </Text>
              )}
              {status?.displayName && (
                <Text className="text-muted-foreground text-center">
                  {status.displayName}
                </Text>
              )}
              <Text className="text-sm text-muted-foreground text-center">
                Alia will respond to messages on your WhatsApp. People who message you can chat with Alia.
              </Text>
              <Button
                variant="destructive"
                className="w-full mt-4"
                onPress={() => setShowDisconnectDialog(true)}
              >
                <Text className="text-destructive-foreground">Disconnect WhatsApp</Text>
              </Button>
            </View>
          ) : qrData || isQrPending ? (
            /* QR Code State */
            <View className="items-center gap-4 w-full">
              <Text className="text-lg font-semibold text-center">Scan QR Code</Text>
              <Text className="text-sm text-muted-foreground text-center">
                Open WhatsApp on your phone, go to Settings &gt; Linked Devices &gt; Link a Device, then scan this code.
              </Text>

              {qrData ? (
                <View className="bg-white p-4 rounded-2xl">
                  <QRCode
                    value={qrData}
                    size={250}
                    backgroundColor="white"
                    color="black"
                  />
                </View>
              ) : (
                <View className="w-[282px] h-[282px] bg-muted rounded-2xl items-center justify-center">
                  <ActivityIndicator size="large" />
                  <Text className="text-sm text-muted-foreground mt-2">Generating QR code...</Text>
                </View>
              )}

              <View className="flex-row items-center gap-2 mt-2">
                <ActivityIndicator size="small" />
                <Text className="text-sm text-muted-foreground">Waiting for scan...</Text>
              </View>

              <Button
                variant="outline"
                className="w-full mt-2"
                onPress={() => {
                  setQrData(null);
                  setConnecting(false);
                  setPolling(false);
                }}
              >
                <Text>Cancel</Text>
              </Button>
            </View>
          ) : (
            /* Disconnected / Initial State */
            <View className="items-center gap-4 w-full">
              <View className="bg-primary/10 p-6 rounded-full">
                <Smartphone size={48} className="text-primary" />
              </View>
              <Text className="text-xl font-bold text-center">Link Your WhatsApp</Text>
              <Text className="text-sm text-muted-foreground text-center leading-5">
                Connect your WhatsApp account to let Alia respond to messages on your behalf. You'll scan a QR code with your phone, just like WhatsApp Web.
              </Text>

              <View className="bg-muted/50 rounded-xl p-4 w-full gap-2 mt-2">
                <Text className="text-sm font-medium">How it works:</Text>
                <Text className="text-sm text-muted-foreground">1. Tap "Connect" below</Text>
                <Text className="text-sm text-muted-foreground">2. A QR code will appear</Text>
                <Text className="text-sm text-muted-foreground">3. Open WhatsApp &gt; Linked Devices &gt; Link a Device</Text>
                <Text className="text-sm text-muted-foreground">4. Scan the QR code with your phone</Text>
              </View>

              <Button
                className="w-full mt-4"
                onPress={handleConnect}
                disabled={connecting}
              >
                <Text className="text-primary-foreground">
                  {connecting ? "Connecting..." : "Connect WhatsApp"}
                </Text>
              </Button>
            </View>
          )}
        </View>
      </View>

      <ConfirmationDialog
        open={showDisconnectDialog}
        onOpenChange={setShowDisconnectDialog}
        title="Disconnect WhatsApp"
        description="This will disconnect your WhatsApp from Alia. You'll need to scan the QR code again to reconnect."
        confirmText="Disconnect"
        cancelText="Cancel"
        confirmVariant="destructive"
        onConfirm={handleDisconnect}
        loading={disconnecting}
      />
    </View>
  );
}

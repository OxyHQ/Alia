import { useEffect, useRef, useState, useCallback } from "react";
import { View, Image, ActivityIndicator, Platform } from "react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";

interface AgentBrowserProps {
  sessionId: string;
  wsUrl: string;
}

/**
 * Browser screenshot viewer — shows what Alia is browsing in real-time.
 * Receives screenshots and status updates via WebSocket.
 */
export function AgentBrowser({ sessionId, wsUrl }: AgentBrowserProps) {
  const { colors } = useColorScheme();
  const wsRef = useRef<WebSocket | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string>("");
  const [status, setStatus] = useState<string>("Waiting...");
  const [connected, setConnected] = useState(false);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ type: "subscribe", sessionId }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.sessionId !== sessionId) return;

        switch (data.type) {
          case "screenshot":
            setScreenshot(`data:image/jpeg;base64,${data.data}`);
            break;
          case "browser":
            if (data.url) setCurrentUrl(data.url);
            if (data.action) setStatus(data.action);
            if (data.title) setStatus(`${data.action}: ${data.title}`);
            break;
          case "status":
            setStatus(data.action);
            break;
        }
      } catch {}
    };

    ws.onclose = () => {
      setConnected(false);
      // Auto-reconnect after 3 seconds
      setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [wsUrl, sessionId]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
    };
  }, [connect]);

  return (
    <View className="flex-1 bg-neutral-900 rounded-lg overflow-hidden border border-neutral-700">
      {/* URL bar */}
      <View className="flex-row items-center px-3 py-2 bg-neutral-800 border-b border-neutral-700 gap-2">
        <View
          className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`}
        />
        <View className="flex-1 bg-neutral-700 rounded px-2 py-1">
          <Text className="text-muted-foreground text-xs" numberOfLines={1}>
            {currentUrl || "about:blank"}
          </Text>
        </View>
      </View>

      {/* Screenshot area */}
      <View className="flex-1 items-center justify-center">
        {screenshot ? (
          <Image
            source={{ uri: screenshot }}
            className="w-full h-full"
            resizeMode="contain"
          />
        ) : (
          <View className="items-center gap-2">
            <ActivityIndicator color={colors.mutedForeground} />
            <Text className="text-muted-foreground text-sm">
              Waiting for browser activity...
            </Text>
          </View>
        )}
      </View>

      {/* Status bar */}
      <View className="px-3 py-1.5 bg-neutral-800 border-t border-neutral-700">
        <Text className="text-muted-foreground text-xs" numberOfLines={1}>
          {status}
        </Text>
      </View>
    </View>
  );
}

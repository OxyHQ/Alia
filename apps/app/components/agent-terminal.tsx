import { useEffect, useRef, useState, useCallback } from "react";
import { View, Platform, ActivityIndicator } from "react-native";
import { Text } from "@/components/ui/text";

interface AgentTerminalProps {
  sessionId: string;
  wsUrl: string;
}

/**
 * Terminal viewer for the agent view.
 * - Web: uses xterm.js directly via DOM manipulation
 * - Native: uses a WebView that loads xterm.js from CDN
 */
export function AgentTerminal({ sessionId, wsUrl }: AgentTerminalProps) {
  if (Platform.OS === "web") {
    return <WebTerminal sessionId={sessionId} wsUrl={wsUrl} />;
  }
  return <NativeTerminal sessionId={sessionId} wsUrl={wsUrl} />;
}

// ---------------------------------------------------------------------------
// Web implementation (xterm.js directly)
// ---------------------------------------------------------------------------

function WebTerminal({ sessionId, wsUrl }: AgentTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize xterm
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const { Terminal } = await import("xterm");
        const { FitAddon } = await import("@xterm/addon-fit");

        if (cancelled || !containerRef.current) return;

        // Inject xterm CSS if not already present
        if (!document.getElementById("xterm-css")) {
          const link = document.createElement("link");
          link.id = "xterm-css";
          link.rel = "stylesheet";
          link.href =
            "https://cdn.jsdelivr.net/npm/xterm@5/css/xterm.css";
          document.head.appendChild(link);
        }

        const fitAddon = new FitAddon();
        const terminal = new Terminal({
          cursorBlink: false,
          disableStdin: true,
          fontSize: 13,
          fontFamily: "'Fira Code', 'Cascadia Code', 'Menlo', monospace",
          theme: {
            background: "#0d0d0d",
            foreground: "#d4d4d4",
            cursor: "#d4d4d4",
            selectionBackground: "#264f78",
            black: "#1e1e1e",
            red: "#f44747",
            green: "#6a9955",
            yellow: "#d7ba7d",
            blue: "#569cd6",
            magenta: "#c586c0",
            cyan: "#4ec9b0",
            white: "#d4d4d4",
            brightBlack: "#808080",
            brightRed: "#f44747",
            brightGreen: "#6a9955",
            brightYellow: "#d7ba7d",
            brightBlue: "#569cd6",
            brightMagenta: "#c586c0",
            brightCyan: "#4ec9b0",
            brightWhite: "#ffffff",
          },
          scrollback: 5000,
          convertEol: true,
        });

        terminal.loadAddon(fitAddon);
        terminal.open(containerRef.current);
        fitAddon.fit();

        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;

        terminal.writeln("\x1b[90m--- Agent terminal ---\x1b[0m");
        terminal.writeln("");

        setReady(true);
      } catch (err: any) {
        if (!cancelled) {
          console.error("[AgentTerminal] xterm init error:", err);
          setError(err.message || "Failed to initialize terminal");
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      terminalRef.current?.dispose();
      terminalRef.current = null;
    };
  }, []);

  // Handle resize
  useEffect(() => {
    if (!ready) return;

    const handleResize = () => {
      try {
        fitAddonRef.current?.fit();
      } catch {
        // fit may throw if container is detached
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [ready]);

  // Connect WebSocket
  useEffect(() => {
    if (!ready) return;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "subscribe",
          channel: "terminal",
          sessionId,
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "terminal:output" && data.sessionId === sessionId) {
          terminalRef.current?.write(data.data);
        }
      } catch {
        // If not JSON, write raw data
        terminalRef.current?.write(event.data);
      }
    };

    ws.onerror = () => {
      setError("WebSocket connection failed");
    };

    ws.onclose = () => {
      terminalRef.current?.writeln(
        "\r\n\x1b[90m--- Connection closed ---\x1b[0m"
      );
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [ready, wsUrl, sessionId]);

  if (error) {
    return (
      <View className="flex-1 bg-[#0d0d0d] items-center justify-center p-4">
        <Text className="text-red-400 text-sm">{error}</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-[#0d0d0d] overflow-hidden rounded-lg border border-border">
      {!ready && (
        <View className="absolute inset-0 items-center justify-center z-10">
          <ActivityIndicator size="small" color="#808080" />
          <Text className="text-muted-foreground text-xs mt-2">
            Loading terminal...
          </Text>
        </View>
      )}
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          minHeight: 200,
        }}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Native implementation (WebView with xterm.js from CDN)
// ---------------------------------------------------------------------------

const TERMINAL_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5/css/xterm.css" />
  <script src="https://cdn.jsdelivr.net/npm/xterm@5/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: #0d0d0d; overflow: hidden; }
    #terminal { width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <script>
    const fitAddon = new FitAddon.FitAddon();
    const term = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      fontSize: 12,
      fontFamily: "'Menlo', 'Courier New', monospace",
      theme: {
        background: '#0d0d0d',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        selectionBackground: '#264f78',
        black: '#1e1e1e',
        red: '#f44747',
        green: '#6a9955',
        yellow: '#d7ba7d',
        blue: '#569cd6',
        magenta: '#c586c0',
        cyan: '#4ec9b0',
        white: '#d4d4d4',
        brightBlack: '#808080',
        brightRed: '#f44747',
        brightGreen: '#6a9955',
        brightYellow: '#d7ba7d',
        brightBlue: '#569cd6',
        brightMagenta: '#c586c0',
        brightCyan: '#4ec9b0',
        brightWhite: '#ffffff',
      },
      scrollback: 5000,
      convertEol: true,
    });

    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));
    fitAddon.fit();

    term.writeln('\\x1b[90m--- Agent terminal ---\\x1b[0m');
    term.writeln('');

    // Listen for messages from React Native
    window.addEventListener('message', function(event) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'write') {
          term.write(msg.data);
        } else if (msg.type === 'fit') {
          fitAddon.fit();
        }
      } catch(e) {}
    });

    // Also listen for document message (Android WebView)
    document.addEventListener('message', function(event) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'write') {
          term.write(msg.data);
        } else if (msg.type === 'fit') {
          fitAddon.fit();
        }
      } catch(e) {}
    });

    // Signal ready
    window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'ready' }));
  </script>
</body>
</html>
`;

function NativeTerminal({ sessionId, wsUrl }: AgentTerminalProps) {
  const webViewRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [webViewReady, setWebViewReady] = useState(false);
  const [WebViewComponent, setWebViewComponent] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  // Dynamically import WebView
  useEffect(() => {
    let cancelled = false;
    import("react-native-webview")
      .then((mod) => {
        if (!cancelled) {
          setWebViewComponent(() => mod.default || mod.WebView);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("[AgentTerminal] WebView not available:", err);
          setError(
            "WebView is not available. Install react-native-webview to use the terminal on native."
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Connect WebSocket once WebView is ready
  useEffect(() => {
    if (!webViewReady) return;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "subscribe",
          channel: "terminal",
          sessionId,
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "terminal:output" && data.sessionId === sessionId) {
          webViewRef.current?.postMessage(
            JSON.stringify({ type: "write", data: data.data })
          );
        }
      } catch {
        webViewRef.current?.postMessage(
          JSON.stringify({ type: "write", data: event.data })
        );
      }
    };

    ws.onerror = () => {
      setError("WebSocket connection failed");
    };

    ws.onclose = () => {
      webViewRef.current?.postMessage(
        JSON.stringify({
          type: "write",
          data: "\r\n\x1b[90m--- Connection closed ---\x1b[0m",
        })
      );
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [webViewReady, wsUrl, sessionId]);

  const handleWebViewMessage = useCallback((event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === "ready") {
        setWebViewReady(true);
      }
    } catch {
      // ignore
    }
  }, []);

  if (error) {
    return (
      <View className="flex-1 bg-[#0d0d0d] items-center justify-center p-4">
        <Text className="text-red-400 text-sm">{error}</Text>
      </View>
    );
  }

  if (!WebViewComponent) {
    return (
      <View className="flex-1 bg-[#0d0d0d] items-center justify-center">
        <ActivityIndicator size="small" color="#808080" />
        <Text className="text-muted-foreground text-xs mt-2">
          Loading terminal...
        </Text>
      </View>
    );
  }

  const RNWebView = WebViewComponent;

  return (
    <View className="flex-1 bg-[#0d0d0d] overflow-hidden rounded-lg border border-border">
      <RNWebView
        ref={webViewRef}
        source={{ html: TERMINAL_HTML }}
        originWhitelist={["*"]}
        javaScriptEnabled
        onMessage={handleWebViewMessage}
        style={{ flex: 1, backgroundColor: "#0d0d0d" }}
        scrollEnabled={false}
      />
    </View>
  );
}

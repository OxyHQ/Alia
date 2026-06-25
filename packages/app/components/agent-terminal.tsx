import { useEffect, useRef, useState, useCallback } from "react";
import { View, Platform, ActivityIndicator } from "react-native";
import { Text } from "@/components/ui/text";
import { io as socketIO, type Socket } from "socket.io-client";
import config from "@/lib/config";
import apiClient, { getSocketToken } from "@/lib/api/client";
import { useColorScheme } from "@/lib/useColorScheme";

interface AgentTerminalProps {
  agentId: string;
}

interface AgentActivityEvent {
  type:
    | "system"
    | "thinking"
    | "response"
    | "tool_call"
    | "tool_result"
    | "error"
    | "complete";
  content: string;
  timestamp: number;
  sessionId: string;
  metadata?: { toolName?: string; args?: any; duration?: number };
}

/**
 * Format an activity event into ANSI-colored terminal output.
 */
function formatActivity(event: AgentActivityEvent): string {
  const time = new Date(event.timestamp);
  const ts = `\x1b[90m[${time.toLocaleTimeString("en-US", { hour12: false })}]\x1b[0m`;

  switch (event.type) {
    case "system":
      return `${ts} \x1b[90m\u25B8 ${event.content}\x1b[0m\r\n`;
    case "thinking":
      return `${ts} \x1b[33m\u25C6 ${event.content}\x1b[0m\r\n`;
    case "tool_call":
      return `${ts} \x1b[36m\u26A1 ${event.content}\x1b[0m\r\n`;
    case "tool_result": {
      const truncated =
        event.content.length > 300
          ? event.content.slice(0, 300) + "..."
          : event.content;
      return `${ts} \x1b[90m\u2190 ${truncated}\x1b[0m\r\n`;
    }
    case "response":
      return `${ts} \x1b[32m${event.content}\x1b[0m\r\n`;
    case "error":
      return `${ts} \x1b[31m\u2717 ${event.content}\x1b[0m\r\n`;
    case "complete":
      return `${ts} \x1b[32m\u2713 ${event.content}\x1b[0m\r\n`;
    default:
      return `${ts} ${event.content}\r\n`;
  }
}

/**
 * Terminal viewer for agent activity.
 * - Web: uses xterm.js directly via DOM manipulation
 * - Native: uses a WebView that loads xterm.js from CDN
 *
 * Connects to Socket.IO and subscribes to agent activity events.
 * Backfills recent activity on mount via REST API.
 */
export function AgentTerminal({ agentId }: AgentTerminalProps) {
  if (Platform.OS === "web") {
    return <WebTerminal agentId={agentId} />;
  }
  return <NativeTerminal agentId={agentId} />;
}

// ---------------------------------------------------------------------------
// Web implementation (xterm.js directly)
// ---------------------------------------------------------------------------

function WebTerminal({ agentId }: AgentTerminalProps) {
  const { colors } = useColorScheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const socketRef = useRef<Socket | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize xterm
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const { Terminal } = await import("@xterm/xterm");
        const { FitAddon } = await import("@xterm/addon-fit");

        if (cancelled || !containerRef.current) return;

        // Inject xterm CSS if not already present
        if (!document.getElementById("xterm-css")) {
          const link = document.createElement("link");
          link.id = "xterm-css";
          link.rel = "stylesheet";
          link.href =
            "https://cdn.jsdelivr.net/npm/@xterm/xterm/css/xterm.css";
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

  // Handle resize (ResizeObserver for flex container changes + window fallback)
  useEffect(() => {
    if (!ready || !containerRef.current) return;

    const handleResize = () => {
      try {
        fitAddonRef.current?.fit();
      } catch {
        // fit may throw if container is detached
      }
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(containerRef.current);
    window.addEventListener("resize", handleResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [ready]);

  // Backfill activity + connect Socket.IO
  useEffect(() => {
    if (!ready) return;

    // Backfill recent activity from REST API
    apiClient
      .get(`/agents/${agentId}/activity`)
      .then((res) => {
        const events: AgentActivityEvent[] = res.data?.activity || [];
        for (const event of events) {
          terminalRef.current?.write(formatActivity(event));
        }
        if (events.length === 0) {
          terminalRef.current?.writeln(
            "\x1b[90mWaiting for activity...\x1b[0m"
          );
        }
      })
      .catch(() => {
        // Silently fail backfill
      });

    // Connect Socket.IO
    let wasConnected = false;
    const socket = socketIO(config.apiUrl, {
      // Function form so a fresh token is read on every (re)connect.
      auth: (cb) => cb({ token: getSocketToken() }),
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("subscribe-agent", agentId);
      if (wasConnected) {
        terminalRef.current?.writeln(
          "\x1b[32m\u25B8 Reconnected\x1b[0m"
        );
      }
      wasConnected = true;
    });

    socket.on("agent-activity", (data: any) => {
      if (data.agentId === agentId) {
        terminalRef.current?.write(formatActivity(data));
      }
    });

    socket.on("disconnect", (reason) => {
      if (reason !== "io client disconnect") {
        terminalRef.current?.writeln(
          "\x1b[33m\u25B8 Connection lost — reconnecting...\x1b[0m"
        );
      }
    });

    socket.on("connect_error", () => {
      terminalRef.current?.writeln(
        "\x1b[31m\u25B8 Connection error — retrying...\x1b[0m"
      );
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [ready, agentId]);

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
          <ActivityIndicator size="small" color={colors.mutedForeground} />
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

function NativeTerminal({ agentId }: AgentTerminalProps) {
  const { colors } = useColorScheme();
  const webViewRef = useRef<any>(null);
  const socketRef = useRef<Socket | null>(null);
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

  const writeToWebView = useCallback(
    (text: string) => {
      webViewRef.current?.postMessage(
        JSON.stringify({ type: "write", data: text })
      );
    },
    []
  );

  // Backfill + Socket.IO once WebView is ready
  useEffect(() => {
    if (!webViewReady) return;

    // Backfill recent activity
    apiClient
      .get(`/agents/${agentId}/activity`)
      .then((res) => {
        const events: AgentActivityEvent[] = res.data?.activity || [];
        for (const event of events) {
          writeToWebView(formatActivity(event));
        }
        if (events.length === 0) {
          writeToWebView("\x1b[90mWaiting for activity...\x1b[0m\r\n");
        }
      })
      .catch(() => {});

    // Connect Socket.IO
    let wasConnected = false;
    const socket = socketIO(config.apiUrl, {
      // Function form so a fresh token is read on every (re)connect.
      auth: (cb) => cb({ token: getSocketToken() }),
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("subscribe-agent", agentId);
      if (wasConnected) {
        writeToWebView("\x1b[32m\u25B8 Reconnected\x1b[0m\r\n");
      }
      wasConnected = true;
    });

    socket.on("agent-activity", (data: any) => {
      if (data.agentId === agentId) {
        writeToWebView(formatActivity(data));
      }
    });

    socket.on("disconnect", (reason) => {
      if (reason !== "io client disconnect") {
        writeToWebView("\x1b[33m\u25B8 Connection lost — reconnecting...\x1b[0m\r\n");
      }
    });

    socket.on("connect_error", () => {
      writeToWebView("\x1b[31m\u25B8 Connection error — retrying...\x1b[0m\r\n");
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [webViewReady, agentId, writeToWebView]);

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
        <ActivityIndicator size="small" color={colors.mutedForeground} />
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

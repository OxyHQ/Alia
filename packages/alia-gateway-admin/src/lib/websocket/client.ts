/**
 * WebSocket Client for Real-Time Updates
 * Provides persistent connection to the backend for live data streaming
 */

type MessageHandler = (data: unknown) => void;
type ConnectionHandler = (status: 'connected' | 'disconnected' | 'reconnecting') => void;

interface WebSocketMessage {
  type: string;
  channel?: string;
  data?: unknown;
  error?: string;
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private baseWsUrl: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000; // Start with 1 second
  private maxReconnectDelay = 30000; // Max 30 seconds
  private reconnectTimeout: number | null = null;
  private messageHandlers = new Map<string, Set<MessageHandler>>();
  private connectionHandlers = new Set<ConnectionHandler>();
  private isIntentionallyClosed = false;
  private heartbeatInterval: number | null = null;
  private heartbeatTimeout: number | null = null;
  private getToken: (() => string | null) | null = null;
  private pendingMessages: unknown[] = [];

  constructor(apiUrl?: string) {
    // Convert HTTP URL to WebSocket URL
    const baseUrl = apiUrl || import.meta.env.VITE_GATEWAY_API_URL || 'http://localhost:3001/internal/gateway';
    this.baseWsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';
  }

  /**
   * Set the function to retrieve the current auth token
   */
  setTokenGetter(getter: () => string | null): void {
    this.getToken = getter;
  }

  /**
   * Connect to WebSocket server
   */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return; // Already connected or connecting
    }

    this.isIntentionallyClosed = false;

    // Include auth token in connection URL
    const token = this.getToken?.();
    if (!token) {
      return;
    }
    const url = `${this.baseWsUrl}?token=${encodeURIComponent(token)}`;

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        this.notifyConnectionHandlers('connected');
        this.startHeartbeat();
        this.resubscribeChannels();
        this.flushPendingMessages();
      };

      this.ws.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (error) {
          console.error('[WebSocket] Failed to parse message:', error);
        }
      };

      this.ws.onerror = () => {
        // Connection error — reconnect will be triggered by onclose
      };

      this.ws.onclose = () => {
        this.stopHeartbeat();
        this.notifyConnectionHandlers('disconnected');

        // Attempt reconnection if not intentionally closed
        if (!this.isIntentionallyClosed) {
          this.scheduleReconnect();
        }
      };
    } catch {
      if (!this.isIntentionallyClosed) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    this.isIntentionallyClosed = true;
    this.stopHeartbeat();
    this.pendingMessages.length = 0;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      return;
    }

    this.reconnectAttempts++;
    this.notifyConnectionHandlers('reconnecting');

    // Exponential backoff: 1s, 2s, 4s, 8s, ..., up to 30s
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    // Send ping every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' });

        // Expect pong within 5 seconds
        this.heartbeatTimeout = setTimeout(() => {
          this.ws?.close();
        }, 5000);
      }
    }, 30000);
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  /**
   * Send message to server
   */
  send(message: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else if (this.ws?.readyState === WebSocket.CONNECTING) {
      this.pendingMessages.push(message);
    }
    // Silently skip when not connected — channels are re-subscribed on connect
  }

  private flushPendingMessages(): void {
    const messages = this.pendingMessages.splice(0);
    for (const message of messages) {
      this.send(message);
    }
  }

  private resubscribeChannels(): void {
    for (const channel of this.messageHandlers.keys()) {
      this.send({ type: 'subscribe', channel });
    }
  }

  /**
   * Subscribe to a specific channel/event type
   */
  subscribe(channel: string, handler: MessageHandler): () => void {
    if (!this.messageHandlers.has(channel)) {
      this.messageHandlers.set(channel, new Set());
    }
    this.messageHandlers.get(channel)!.add(handler);

    // Send subscription message to server
    this.send({ type: 'subscribe', channel });

    // Return unsubscribe function
    return () => this.unsubscribe(channel, handler);
  }

  /**
   * Unsubscribe from a channel
   */
  unsubscribe(channel: string, handler: MessageHandler): void {
    const handlers = this.messageHandlers.get(channel);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.messageHandlers.delete(channel);
        // Send unsubscribe message to server
        this.send({ type: 'unsubscribe', channel });
      }
    }
  }

  /**
   * Subscribe to connection status changes
   */
  onConnectionChange(handler: ConnectionHandler): () => void {
    this.connectionHandlers.add(handler);

    // Immediately notify of current status
    const currentStatus = this.ws?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected';
    handler(currentStatus);

    // Return unsubscribe function
    return () => this.connectionHandlers.delete(handler);
  }

  /**
   * Handle incoming message
   */
  private handleMessage(message: WebSocketMessage): void {
    const { type, channel, data } = message;

    // Handle pong response
    if (type === 'pong') {
      if (this.heartbeatTimeout) {
        clearTimeout(this.heartbeatTimeout);
        this.heartbeatTimeout = null;
      }
      return;
    }

    // Handle error messages
    if (type === 'error') {
      console.error('[WebSocket] Server error:', message.error);
      return;
    }

    // Notify channel-specific handlers
    if (channel) {
      const handlers = this.messageHandlers.get(channel);
      if (handlers) {
        handlers.forEach((handler) => {
          try {
            handler(data);
          } catch (error) {
            console.error('[WebSocket] Handler error:', error);
          }
        });
      }
    }

    // Also notify type-specific handlers
    const typeHandlers = this.messageHandlers.get(type);
    if (typeHandlers) {
      typeHandlers.forEach((handler) => {
        try {
          handler(data);
        } catch (error) {
          console.error('[WebSocket] Handler error:', error);
        }
      });
    }
  }

  /**
   * Notify connection status handlers
   */
  private notifyConnectionHandlers(status: 'connected' | 'disconnected' | 'reconnecting'): void {
    this.connectionHandlers.forEach((handler) => {
      try {
        handler(status);
      } catch (error) {
        console.error('[WebSocket] Connection handler error:', error);
      }
    });
  }

  /**
   * Get current connection status
   */
  getStatus(): 'connected' | 'disconnected' | 'reconnecting' | 'connecting' {
    if (!this.ws) return 'disconnected';

    switch (this.ws.readyState) {
      case WebSocket.CONNECTING:
        return 'connecting';
      case WebSocket.OPEN:
        return 'connected';
      case WebSocket.CLOSING:
      case WebSocket.CLOSED:
        return this.reconnectTimeout ? 'reconnecting' : 'disconnected';
      default:
        return 'disconnected';
    }
  }
}

// Singleton instance
export const realtimeClient = new RealtimeClient();

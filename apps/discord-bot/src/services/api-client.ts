import axios, { AxiosInstance } from 'axios';

class APIClient {
  private client: AxiosInstance;
  private baseURL: string;
  private botSecret: string;

  constructor() {
    this.baseURL = process.env.API_BASE_URL || 'http://localhost:3001';
    this.botSecret = process.env.DISCORD_BOT_SECRET || '';
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private get authHeaders() {
    return { 'X-Channel-Bot-Secret': this.botSecret };
  }

  // Channel user management (via /channels/discord/*)
  async getChannelUser(discordUserId: string): Promise<any> {
    const response = await this.client.get(`/channels/discord/users/${discordUserId}`, {
      headers: this.authHeaders,
    });
    return response.data;
  }

  async createOrUpdateChannelUser(data: {
    channelUserId: string;
    chatId: string;
    username?: string;
    displayName?: string;
  }): Promise<any> {
    const response = await this.client.post('/channels/discord/users', data, {
      headers: this.authHeaders,
    });
    return response.data;
  }

  async requestAuthToken(channelUserId: string): Promise<{ authToken: string; authUrl: string; expiresAt: Date }> {
    const response = await this.client.post('/channels/discord/auth-request',
      { channelUserId },
      { headers: this.authHeaders }
    );
    return response.data;
  }

  async updateConversation(channelUserId: string, conversationId: string): Promise<void> {
    await this.client.post(`/channels/discord/users/${channelUserId}/conversation`,
      { conversationId },
      { headers: this.authHeaders }
    );
  }

  async updateModel(channelUserId: string, model: string): Promise<void> {
    await this.client.post(`/channels/discord/users/${channelUserId}/model`,
      { model },
      { headers: this.authHeaders }
    );
  }

  async logoutUser(channelUserId: string): Promise<void> {
    await this.client.post(`/channels/discord/users/${channelUserId}/logout`,
      {},
      { headers: this.authHeaders }
    );
  }

  // Conversations
  async getConversation(oxyUserId: string, conversationId: string): Promise<any> {
    try {
      const response = await this.client.get(`/conversations/${conversationId}`, {
        headers: { ...this.authHeaders, 'X-Oxy-User-Id': oxyUserId },
      });
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) return null;
      throw error;
    }
  }

  async saveConversation(oxyUserId: string, conversationId: string, messages: any[], title?: string): Promise<any> {
    const response = await this.client.post('/conversations',
      { conversationId, messages, title },
      { headers: { ...this.authHeaders, 'X-Oxy-User-Id': oxyUserId } }
    );
    return response.data;
  }

  async getConversations(oxyUserId: string): Promise<any[]> {
    const response = await this.client.get('/conversations', {
      headers: { ...this.authHeaders, 'X-Oxy-User-Id': oxyUserId },
    });
    return response.data;
  }

  // Models
  async fetchModels(): Promise<any[]> {
    try {
      const response = await this.client.get('/v1/models');
      return response.data.data || [];
    } catch { return []; }
  }
}

export const apiClient = new APIClient();

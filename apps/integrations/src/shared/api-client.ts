import axios, { AxiosInstance } from 'axios';

/**
 * Parameterized API client — one instance per platform, all sharing the same core logic.
 */
export class APIClient {
  private client: AxiosInstance;
  private platform: string;
  private secret: string;

  constructor(platform: string, secret: string) {
    this.platform = platform;
    this.secret = secret;
    const baseURL = process.env.API_BASE_URL || 'http://localhost:3001';
    this.client = axios.create({
      baseURL,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private get authHeaders() {
    return { 'X-Channel-Bot-Secret': this.secret };
  }

  async getChannelUser(channelUserId: string): Promise<any> {
    try {
      const response = await this.client.get(
        `/channels/${this.platform}/users/${channelUserId}`,
        { headers: this.authHeaders },
      );
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) return null;
      throw error;
    }
  }

  async createOrUpdateChannelUser(data: {
    channelUserId: string;
    phoneNumber?: string;
    displayName?: string;
  }): Promise<any> {
    const response = await this.client.post(
      `/channels/${this.platform}/users`,
      data,
      { headers: this.authHeaders },
    );
    return response.data;
  }

  async requestAuthToken(channelUserId: string): Promise<{
    authToken: string;
    authUrl: string;
    expiresAt: Date;
  }> {
    const response = await this.client.post(
      `/channels/${this.platform}/auth-request`,
      { channelUserId },
      { headers: this.authHeaders },
    );
    return response.data;
  }

  async updateConversation(channelUserId: string, conversationId: string): Promise<void> {
    await this.client.post(
      `/channels/${this.platform}/users/${channelUserId}/conversation`,
      { conversationId },
      { headers: this.authHeaders },
    );
  }

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

  async saveConversation(
    oxyUserId: string,
    conversationId: string,
    messages: any[],
    title?: string,
  ): Promise<any> {
    const response = await this.client.post(
      '/conversations',
      { conversationId, messages, title },
      { headers: { ...this.authHeaders, 'X-Oxy-User-Id': oxyUserId } },
    );
    return response.data;
  }

  async getConversations(oxyUserId: string): Promise<any[]> {
    const response = await this.client.get('/conversations', {
      headers: { ...this.authHeaders, 'X-Oxy-User-Id': oxyUserId },
    });
    return response.data;
  }

  async fetchModels(): Promise<any[]> {
    try {
      const response = await this.client.get('/v1/models');
      return response.data.data || [];
    } catch {
      return [];
    }
  }

  async updateModel(channelUserId: string, model: string): Promise<void> {
    await this.client.post(
      `/channels/${this.platform}/users/${channelUserId}/model`,
      { model },
      { headers: this.authHeaders },
    );
  }

  async logoutUser(channelUserId: string): Promise<void> {
    await this.client.post(
      `/channels/${this.platform}/users/${channelUserId}/logout`,
      {},
      { headers: this.authHeaders },
    );
  }
}

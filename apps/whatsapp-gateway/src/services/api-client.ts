import axios, { AxiosInstance } from 'axios';

class APIClient {
  private client: AxiosInstance;
  private baseURL: string;

  constructor() {
    this.baseURL = process.env.API_BASE_URL || 'http://localhost:3001';
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  private get botSecret(): string {
    return process.env.WHATSAPP_GATEWAY_SECRET || '';
  }

  // Channel User Management

  async getChannelUser(channelUserId: string): Promise<any> {
    try {
      const response = await this.client.get(`/channels/whatsapp/users/${channelUserId}`, {
        headers: {
          'X-Channel-Bot-Secret': this.botSecret,
        },
      });
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async createOrUpdateChannelUser(data: {
    channelUserId: string;
    phoneNumber?: string;
    displayName?: string;
  }): Promise<any> {
    const response = await this.client.post('/channels/whatsapp/users', data, {
      headers: {
        'X-Channel-Bot-Secret': this.botSecret,
      },
    });
    return response.data;
  }

  async requestAuthToken(channelUserId: string): Promise<{
    authToken: string;
    authUrl: string;
    expiresAt: Date;
  }> {
    const response = await this.client.post(
      '/channels/whatsapp/auth-request',
      { channelUserId },
      {
        headers: {
          'X-Channel-Bot-Secret': this.botSecret,
        },
      }
    );
    return response.data;
  }

  async updateConversation(channelUserId: string, conversationId: string): Promise<void> {
    await this.client.post(
      `/channels/whatsapp/users/${channelUserId}/conversation`,
      { conversationId },
      {
        headers: {
          'X-Channel-Bot-Secret': this.botSecret,
        },
      }
    );
  }

  // Conversations

  async getConversation(oxyUserId: string, conversationId: string): Promise<any> {
    try {
      const response = await this.client.get(`/conversations/${conversationId}`, {
        headers: {
          'X-Channel-Bot-Secret': this.botSecret,
          'X-Oxy-User-Id': oxyUserId,
        },
      });
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async saveConversation(
    oxyUserId: string,
    conversationId: string,
    messages: any[],
    title?: string
  ): Promise<any> {
    const response = await this.client.post(
      '/conversations',
      {
        conversationId,
        messages,
        title,
      },
      {
        headers: {
          'X-Channel-Bot-Secret': this.botSecret,
          'X-Oxy-User-Id': oxyUserId,
        },
      }
    );
    return response.data;
  }

  // Models

  async fetchModels(): Promise<
    {
      id: string;
      name: string;
      description: string;
      emoji?: string;
      category: string;
      pricing: { credit_multiplier: number };
    }[]
  > {
    try {
      const response = await this.client.get('/v1/models');
      return response.data.data || [];
    } catch {
      return [];
    }
  }
}

export const apiClient = new APIClient();

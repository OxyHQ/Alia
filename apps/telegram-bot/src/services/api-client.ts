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

  // Authentication
  async login(email: string, password: string): Promise<{ token: string; user: any }> {
    const response = await this.client.post('/auth/login', { email, password });
    return response.data;
  }

  async getMe(token: string): Promise<any> {
    const response = await this.client.get('/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  }

  // Chat with Alia
  async chat(token: string, message: string, conversationId?: string): Promise<ReadableStream> {
    const response = await this.client.post(
      '/alia/chat',
      {
        message,
        conversationId,
      },
      {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'stream',
      }
    );
    return response.data;
  }

  // Conversations
  async getConversations(botSecret: string, oxyUserId: string): Promise<any[]> {
    const response = await this.client.get('/conversations', {
      headers: {
        'X-Telegram-Bot-Secret': botSecret,
        'X-Oxy-User-Id': oxyUserId,
      },
    });
    return response.data;
  }

  async getConversation(botSecret: string, oxyUserId: string, conversationId: string): Promise<any> {
    try {
      const response = await this.client.get(`/conversations/${conversationId}`, {
        headers: {
          'X-Telegram-Bot-Secret': botSecret,
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
    botSecret: string,
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
          'X-Telegram-Bot-Secret': botSecret,
          'X-Oxy-User-Id': oxyUserId,
        },
      }
    );
    return response.data;
  }

  async deleteConversation(token: string, conversationId: string): Promise<void> {
    await this.client.delete(`/conversations/${conversationId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  // Memory
  async getMemory(token: string): Promise<any> {
    const response = await this.client.get('/memory', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  }

  // Credits
  async getCredits(token: string): Promise<{ credits: number; freeCredits: number }> {
    const response = await this.client.get('/credits', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  }

  // Telegram User Management
  async requestTelegramLink(telegramId: string): Promise<{ authToken: string; authUrl: string; expiresAt: Date }> {
    const response = await this.client.post('/telegram/link-request', { telegramId });
    return response.data;
  }

  async getTelegramUser(telegramId: string): Promise<any> {
    const response = await this.client.get(`/telegram/users/${telegramId}`);
    return response.data;
  }

  async createOrUpdateTelegramUser(data: {
    telegramId: string;
    chatId: string;
    username?: string;
    firstName?: string;
    lastName?: string;
  }): Promise<any> {
    const response = await this.client.post('/telegram/users', data);
    return response.data;
  }

  async requestTelegramAuth(telegramId: string): Promise<{ authToken: string; authUrl: string; expiresAt: Date }> {
    const response = await this.client.post('/telegram/auth-request', { telegramId });
    return response.data;
  }

  async updateTelegramConversation(telegramId: string, conversationId: string): Promise<void> {
    await this.client.post(`/telegram/users/${telegramId}/conversation`, { conversationId });
  }

  async updateTelegramModel(telegramId: string, model: string): Promise<{ success: boolean; model: string }> {
    const response = await this.client.post(`/telegram/users/${telegramId}/model`, { model });
    return response.data;
  }

  async logoutTelegram(telegramId: string): Promise<void> {
    await this.client.post(`/telegram/users/${telegramId}/logout`);
  }

  async completeSignIn(data: {
    authCode: string;
    telegramId: string;
    chatId: string;
    username?: string;
    firstName?: string;
    lastName?: string;
  }): Promise<{ success: boolean; isNewUser: boolean; user?: any }> {
    const response = await this.client.post('/telegram/signin-complete', data);
    return response.data;
  }

  // Models
  async fetchModels(): Promise<{ id: string; name: string; description: string; emoji?: string; category: string; pricing: { credit_multiplier: number } }[]> {
    try {
      const response = await this.client.get('/v1/models');
      return response.data.data || [];
    } catch {
      return [];
    }
  }

  // Generate auth URL for user verification
  getAuthURL(authToken: string): string {
    return `${this.baseURL}/telegram/verify?token=${authToken}`;
  }
}

export const apiClient = new APIClient();

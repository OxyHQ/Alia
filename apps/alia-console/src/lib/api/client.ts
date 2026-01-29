import axios from 'axios';
import config from '../config';

// Create axios instance
const apiClient = axios.create({
  baseURL: config.apiUrl,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true, // Include cookies for cross-origin requests
});

// Token getter - will be set by ApiAuthSetup component
let getAccessToken: (() => Promise<string | null>) | null = null;

export function setTokenGetter(getter: () => Promise<string | null>) {
  getAccessToken = getter;
}

// Request interceptor to add authentication
apiClient.interceptors.request.use(
  async (requestConfig) => {
    if (getAccessToken) {
      const token = await getAccessToken();
      if (token) {
        requestConfig.headers['Authorization'] = `Bearer ${token}`;
      }
    }
    return requestConfig;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor for error handling
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    // Handle 401 errors - might need to refresh token
    if (error.response?.status === 401) {
      console.warn('API returned 401 - authentication may have expired');
    }
    return Promise.reject(error);
  }
);

export default apiClient;

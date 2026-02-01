import axios from 'axios';
import config from '../config';

// Create axios instance
const apiClient = axios.create({
  baseURL: config.apiUrl,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Token getter - will be set by AuthSetup component
let getAccessToken: (() => string | null) | null = null;

export function setTokenGetter(getter: () => string | null) {
  getAccessToken = getter;
}

// Request interceptor to add Bearer JWT token
apiClient.interceptors.request.use(
  (config) => {
    if (getAccessToken) {
      const token = getAccessToken();
      if (token) {
        config.headers['Authorization'] = `Bearer ${token}`;
      }
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor for error handling
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    // Let components handle auth errors
    return Promise.reject(error);
  }
);

export default apiClient;

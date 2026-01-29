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

// Get session ID from localStorage (where @oxyhq/services/web stores it)
function getSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const sessionData = localStorage.getItem('oxy_session');
    if (sessionData) {
      const session = JSON.parse(sessionData);
      return session?.id || session?._id || null;
    }
    return null;
  } catch {
    return null;
  }
}

// Get access token from localStorage
function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem('oxy_access_token');
  } catch {
    return null;
  }
}

// Request interceptor to add authentication
apiClient.interceptors.request.use(
  (config) => {
    const sessionId = getSessionId();
    if (sessionId) {
      config.headers['x-session-id'] = sessionId;
    }

    const accessToken = getAccessToken();
    if (accessToken) {
      config.headers['Authorization'] = `Bearer ${accessToken}`;
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
    return Promise.reject(error);
  }
);

export default apiClient;

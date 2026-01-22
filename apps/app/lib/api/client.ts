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

// Session getter - will be set by OxyAuthSetup component
let getSessionId: (() => string | null) | null = null;

export function setSessionGetter(getter: () => string | null) {
  getSessionId = getter;
}

// Request interceptor to add Oxy session ID
apiClient.interceptors.request.use(
  (config) => {
    if (getSessionId) {
      const sessionId = getSessionId();
      if (sessionId) {
        // Pass session as x-session-id header for Alia API
        config.headers['x-session-id'] = sessionId;
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

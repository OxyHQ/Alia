import axios from 'axios';
import config from '../config';

// Create axios instance
const apiClient = axios.create({
  baseURL: config.apiUrl,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Token getter - will be set by AuthSetup component
let getAccessToken: (() => string | null) | null = null;

export function setTokenGetter(getter: () => string | null) {
  getAccessToken = getter;
}

/**
 * Returns the current Oxy access token for Socket.IO handshakes.
 * Socket connections must authenticate via the auth-function form
 * `auth: (cb) => cb({ token: getSocketToken() })` so a fresh token is read on
 * every (re)connect and the server's `oxy.authSocket()` middleware accepts it.
 */
export function getSocketToken(): string | null {
  return getAccessToken ? getAccessToken() : null;
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

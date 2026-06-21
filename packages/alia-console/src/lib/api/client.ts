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

// Workspace ID getter - set once, sent on every request via X-Workspace-Id header
let getWorkspaceId: (() => string) | null = null;

export function setWorkspaceGetter(getter: () => string) {
  getWorkspaceId = getter;
}

// Request interceptor to add authentication and workspace context
apiClient.interceptors.request.use(
  async (requestConfig) => {
    if (getAccessToken) {
      const token = await getAccessToken();
      if (token) {
        requestConfig.headers['Authorization'] = `Bearer ${token}`;
      }
    }
    if (getWorkspaceId) {
      requestConfig.headers['X-Workspace-Id'] = getWorkspaceId();
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
  async (error) => {
    if (error.response?.status === 401) {
      const errorData = error.response.data;
      const errorCode = errorData?.code || 'UNKNOWN';
      console.error(`[Auth] 401 on ${error.config?.url}: ${errorCode} - ${errorData?.message || 'Unknown error'}`);

      // Retry once with a fresh token for expired tokens
      if (
        !error.config._authRetried &&
        getAccessToken &&
        (errorCode === 'TOKEN_EXPIRED' || errorCode === 'INVALID_SESSION' || errorCode === 'SESSION_VALIDATION_ERROR')
      ) {
        error.config._authRetried = true;
        const freshToken = await getAccessToken();
        if (freshToken) {
          error.config.headers['Authorization'] = `Bearer ${freshToken}`;
          return apiClient(error.config);
        }
      }
    }
    return Promise.reject(error);
  }
);

export default apiClient;

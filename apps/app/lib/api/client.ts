import axios from 'axios';
import config from '../config';

// Create axios instance without interceptors initially
const apiClient = axios.create({
  baseURL: config.apiUrl,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Setup interceptors function to be called after store is available
// This avoids worklet serialization issues
let interceptorsSetup = false;

export function setupAuthInterceptors() {
  if (interceptorsSetup) return;

  // Import inside function to avoid circular dependencies and worklet issues
  const { useAuthStore } = require('../stores/auth-store');

  // Request interceptor para añadir el token
  apiClient.interceptors.request.use(
    (config) => {
      const token = useAuthStore.getState().token;
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    },
    (error) => {
      return Promise.reject(error);
    }
  );

  // Response interceptor para manejar errores
  apiClient.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.response?.status === 401) {
        // Token inválido o expirado
        useAuthStore.getState().logout();
      }
      return Promise.reject(error);
    }
  );

  interceptorsSetup = true;
}

export default apiClient;

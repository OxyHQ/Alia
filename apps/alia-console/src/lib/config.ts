const config = {
  apiUrl: import.meta.env.VITE_API_URL || 'https://api.alia.onl',
  oxyUrl: import.meta.env.VITE_OXY_URL || 'https://api.oxy.so',
  oxyClientId:
    import.meta.env.VITE_OXY_CLIENT_ID || 'oxy_dk_06488927793f96922ef4f366a9800547b34c6aec025fece3',
};

export default config;

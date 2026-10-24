const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');

// The preset owns the monorepo watch folder and block list, symlink +
// package-exports resolution, the font/wasm asset extensions, NativeWind
// (`./global.css`, 1rem = 16px) and the complete `react-native` behind
// NativeWind's shim, without which `expo-asset` reads React Native 0.88's
// `AssetRegistry` as undefined and an Android release build stays blank.
const config = createOxyMetroConfig(__dirname);

// A fixtures build (EXPO_PUBLIC_ALIA_FIXTURES=1, see fixtures/entry.tsx)
// inlines a different value into every module that reads it, so its
// transforms must never be served to an ordinary build from the shared
// cache, nor the other way round. A distinct cache version keys them apart.
if (process.env.EXPO_PUBLIC_ALIA_FIXTURES === '1') {
  config.cacheVersion = `${config.cacheVersion ?? ''}:alia-fixtures`;
}

module.exports = config;

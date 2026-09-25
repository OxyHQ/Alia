const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require('nativewind/metro');

module.exports = (() => {
  const config = getDefaultConfig(__dirname);

  // A fixtures build (EXPO_PUBLIC_ALIA_FIXTURES=1, see fixtures/entry.tsx)
  // inlines a different value into every module that reads it, so its
  // transforms must never be served to an ordinary build from the shared
  // cache, nor the other way round. A distinct cache version keys them apart.
  if (process.env.EXPO_PUBLIC_ALIA_FIXTURES === '1') {
    config.cacheVersion = `${config.cacheVersion ?? ''}:alia-fixtures`;
  }

  // Enable package exports for zod v4 compatibility
  config.resolver.unstable_enablePackageExports = true;

  // Add web-specific resolver settings to handle ESM modules
  config.resolver.sourceExts = [...config.resolver.sourceExts, 'mjs', 'cjs'];

  // SVG support for react-native-svg-transformer (Expo transformer)
  const { transformer, resolver } = config;
  config.transformer = {
    ...transformer,
    babelTransformerPath: require.resolve("react-native-svg-transformer/expo"),
  };
  config.resolver = {
    ...resolver,
    assetExts: [...resolver.assetExts.filter((ext) => ext !== "svg"), "wasm", "woff2", "woff"],
    sourceExts: [...resolver.sourceExts, "svg"],
  };

  return withNativeWind(config, {
    input: './global.css',
    inlineRem: 16,
    inlineVariables: false
  });
})();

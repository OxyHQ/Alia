const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

module.exports = (() => {
  const config = getDefaultConfig(__dirname);

  // Enable package exports for zod v4 compatibility
  config.resolver.unstable_enablePackageExports = true;

  // Add web-specific resolver settings to handle ESM modules
  config.resolver.sourceExts = [...config.resolver.sourceExts, 'mjs', 'cjs'];

  // Monorepo-safe: solo incluir carpetas necesarias en watchFolders
  config.watchFolders = [
    path.resolve(__dirname, 'node_modules'),
    // Si necesitas otras libs del workspace, solo inclúyelas individualmente
  ];

  // SVG support for react-native-svg-transformer (Expo transformer)
  const { transformer, resolver } = config;
  config.transformer = {
    ...transformer,
    babelTransformerPath: require.resolve("react-native-svg-transformer/expo")
  };
  config.resolver = {
    ...resolver,
    assetExts: resolver.assetExts.filter((ext) => ext !== "svg"),
    sourceExts: [...resolver.sourceExts, "svg"]
  };

  return withNativeWind(config, {
    input: './global.css',
    inlineRem: 16
  });
})();

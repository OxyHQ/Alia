const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

const projectRoot = __dirname;

const config = getDefaultConfig(projectRoot);

// Enable package exports for zod v4 compatibility
config.resolver.unstable_enablePackageExports = true;

// Add web-specific resolver settings to handle ESM modules
config.resolver.sourceExts = [...config.resolver.sourceExts, 'mjs', 'cjs'];

// Monorepo-safe: solo incluir carpetas necesarias en watchFolders
// Evitar incluir todo el workspace para no duplicar React
config.watchFolders = [
  path.resolve(projectRoot, 'node_modules'),
  // Si necesitas otras libs del workspace, solo inclúyelas individualmente
];

// No toques nodeModulesPaths, deja que Metro resuelva desde la app

module.exports = withNativeWind(config, {
  input: './global.css',
  inlineRem: 16
});

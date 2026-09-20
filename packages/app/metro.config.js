const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require('nativewind/metro');

// Web shim for react-native-track-player (avoids bundling shaka-player)
const trackPlayerWebShim = path.resolve(
  __dirname,
  "lib/shims/react-native-track-player.web.js"
);

/**
 * Icon-barrel redirects, web only.
 *
 * Metro does not tree shake the web export, so an icon package whose root entry
 * re-exports its whole set lands in `index-*.js` in full, however few glyphs a
 * screen names. Measured on the baseline export: `lucide-react-native`
 * 1,836,042 B for 146 used icons, `@radix-ui/react-icons` 424,282 B for two.
 *
 * Both redirects are gated on `platform === "web"` so native resolution — and
 * with it every native module registration — is byte-for-byte what it was.
 * `scripts/icon-shims.mjs` generates the lucide barrel and
 * `__tests__/icon-shims.test.ts` fails when either shim stops covering what the
 * source imports.
 */
const webIconBarrelShims = {
  "lucide-react-native": path.resolve(__dirname, "lib/shims/lucide-icons.ts"),
  "@radix-ui/react-icons": path.resolve(__dirname, "lib/shims/radix-icons.tsx"),
};

module.exports = (() => {
  const config = getDefaultConfig(__dirname);

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
    // On web, replace react-native-track-player with a no-op shim so the
    // bundler never pulls in shaka-player (TTS uses expo-speech on web).
    resolveRequest: (context, moduleName, platform) => {
      if (platform === "web" && moduleName === "react-native-track-player") {
        return { filePath: trackPlayerWebShim, type: "sourceFile" };
      }
      if (platform === "web" && moduleName in webIconBarrelShims) {
        return { filePath: webIconBarrelShims[moduleName], type: "sourceFile" };
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  };

  return withNativeWind(config, {
    input: './global.css',
    inlineRem: 16,
    inlineVariables: false
  });
})();

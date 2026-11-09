/**
 * Web: point dotLottie at the WebAssembly renderer SERVED BY THIS ORIGIN.
 *
 * dotLottie draws with ThorVG compiled to WebAssembly and, left alone, fetches that binary from a
 * public npm CDN, which makes every sticker depend on a third party being up. Bundled as an asset
 * instead, it ships under `/assets` with a content hash. If this is ever skipped Bloom's `Sticker`
 * does not break: it shows the sticker's still image instead of the animation.
 *
 * Through Bloom, not `@lottiefiles/dotlottie-react` directly: Bloom loads the player on demand
 * (the first animated sticker), and importing `setWasmUrl` from the player here would pull all of
 * it back into the startup bundle. Bloom keeps the URL and applies it when the player loads.
 */
import { setLottieWasmUrl } from '@oxy.so/bloom/sticker';
import { Asset } from 'expo-asset';

let configured = false;

export function configureLottieWeb(): void {
  if (configured) return;
  configured = true;
  const wasm = Asset.fromModule(require('@lottiefiles/dotlottie-web/dotlottie-player.wasm'));
  setLottieWasmUrl(wasm.uri);
}

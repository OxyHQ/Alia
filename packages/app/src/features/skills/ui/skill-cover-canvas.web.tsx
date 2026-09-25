// Web facade: the cover is the static grid, full stop.
//
// This file deliberately imports NOTHING from `@shopify/react-native-skia` —
// no `LoadSkiaWeb`, no lazy `import()` of the skia canvas, no `useClock`, no
// canvas allocation. The previous version lazy-loaded canvaskit.wasm and then
// turned EVERY mounted cover into an animated Skia canvas, which is what froze
// Chrome on /skills (#545). Animation on web is off until it can be bounded;
// the static grid needs no WASM, no GPU and no blur to be readable.
//
// `skill-cover-canvas-static.test.tsx` mocks the skia package to throw on
// import and renders this module, so a skia import creeping back in fails CI
// rather than a browser.
export { default } from "./skill-cover-static";

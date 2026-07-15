// Native (and default) facade: skia is available synchronously, so render the
// canvas directly. The web counterpart (skill-cover-canvas.web.tsx) lazy-loads
// the skia web runtime instead.
export { default } from "./skill-cover-canvas-skia";

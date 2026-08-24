import { createRoot } from "react-dom/client"
import { applyFontFaces } from "@oxyhq/bloom/fonts"

// CSS is built separately by Gulp
// import "./index.css"
import App from "./App.tsx"

// Injects Bloom's @font-face rules and --bloom-font-* vars; no BloomThemeProvider is mounted
applyFontFaces()

createRoot(document.getElementById("root")!).render(<App />)

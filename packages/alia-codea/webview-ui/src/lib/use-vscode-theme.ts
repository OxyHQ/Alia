import { useSyncExternalStore } from "react"

type ThemeMode = "light" | "dark" | "system"

// VS Code injects one of these classes on <body> and swaps them live (without
// reloading the webview) whenever the user changes their color theme.
function readVscodeMode(): ThemeMode {
  if (typeof document === "undefined") return "system"
  const classes = document.body.classList
  if (classes.contains("vscode-light")) return "light"
  if (classes.contains("vscode-dark") || classes.contains("vscode-high-contrast")) return "dark"
  return "system"
}

function subscribe(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {}
  const observer = new MutationObserver(onChange)
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] })
  return () => observer.disconnect()
}

/**
 * Resolve the active theme mode from VS Code's body class, reactive to live
 * theme switches. Fed to `BloomThemeProvider` as a controlled `mode` so the
 * preset vars Bloom writes to `document.documentElement` always track the
 * editor's light/dark state (those inline vars outrank the class-based CSS, so
 * a one-shot default would freeze the webview to whatever it read on mount).
 * Falls back to `'system'` outside VS Code (e.g. `vite dev`).
 */
export function useVscodeThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, readVscodeMode, () => "system")
}

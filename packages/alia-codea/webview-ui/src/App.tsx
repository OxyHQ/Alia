import { BloomThemeProvider } from "@oxyhq/bloom/theme"
import { Chat } from "@/components/Chat"
import { useVscodeThemeMode } from "@/lib/use-vscode-theme"

export function App() {
  const mode = useVscodeThemeMode()

  // `fonts={false}` keeps the webview on the system-ui stack (VS Code context);
  // Bloom still owns the color tokens via `document.documentElement` vars.
  return (
    <BloomThemeProvider mode={mode} colorPreset="oxy" fonts={false}>
      <Chat />
    </BloomThemeProvider>
  )
}

export default App

import { BloomThemeProvider } from "@oxyhq/bloom/theme"
import { Chat } from "@/components/Chat"
import { useVscodeThemeMode } from "@/lib/use-vscode-theme"

export function App() {
  const mode = useVscodeThemeMode()

  return (
    <BloomThemeProvider mode={mode} colorPreset="oxy">
      <Chat />
    </BloomThemeProvider>
  )
}

export default App

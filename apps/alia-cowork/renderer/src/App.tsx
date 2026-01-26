import * as React from "react"
import { Layout } from "@/components/Layout"
import { Chat } from "@/components/Chat"
import { Browser } from "@/components/Browser"
import { SignIn } from "@/components/SignIn"
import { Settings } from "@/components/Settings"
import { Console } from "@/components/Console"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AuthProvider, useAuth } from "@/contexts/AuthContext"
import { ThemeProvider } from "@/contexts/ThemeContext"
import { ConsoleProvider } from "@/contexts/ConsoleContext"

function AppContent() {
  const [currentView, setCurrentView] = React.useState("chat")
  const { isAuthenticated, isLoading } = useAuth()

  // Listen for browser open/close events from main process
  React.useEffect(() => {
    const handleBrowserOpened = () => {
      setCurrentView("browser")
    }

    const handleBrowserClosed = () => {
      setCurrentView("chat")
    }

    window.electron.on('browser:opened', handleBrowserOpened)
    window.electron.on('browser:closed', handleBrowserClosed)

    return () => {
      window.electron.off('browser:opened', handleBrowserOpened)
      window.electron.off('browser:closed', handleBrowserClosed)
    }
  }, [])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen w-screen bg-background">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <SignIn />
  }

  return (
    <Layout currentView={currentView} onViewChange={setCurrentView}>
      <div className={currentView === "chat" ? "flex-1 flex flex-col overflow-hidden" : "hidden h-0 overflow-hidden"}>
        <Chat />
      </div>
      <div className={currentView === "browser" ? "flex-1 flex flex-col overflow-hidden" : "hidden h-0 overflow-hidden"}>
        <Browser />
      </div>
      <div className={currentView === "files" ? "flex-1 flex items-center justify-center text-muted-foreground overflow-hidden" : "hidden h-0 overflow-hidden"}>
        Files view coming soon
      </div>
      <div className={currentView === "commands" ? "flex-1 flex items-center justify-center text-muted-foreground overflow-hidden" : "hidden h-0 overflow-hidden"}>
        Commands view coming soon
      </div>
      <div className={currentView === "console" ? "flex-1 flex flex-col overflow-hidden" : "hidden h-0 overflow-hidden"}>
        <Console />
      </div>
      <div className={currentView === "settings" ? "flex-1 flex flex-col overflow-hidden" : "hidden h-0 overflow-hidden"}>
        <Settings />
      </div>
    </Layout>
  )
}

export function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <ConsoleProvider>
            <AppContent />
          </ConsoleProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>
  )
}

export default App

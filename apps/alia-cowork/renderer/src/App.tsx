import * as React from "react"
import { Layout } from "@/components/Layout"
import { Chat } from "@/components/Chat"
import { SignIn } from "@/components/SignIn"
import { Settings } from "@/components/Settings"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AuthProvider, useAuth } from "@/contexts/AuthContext"
import { ThemeProvider } from "@/contexts/ThemeContext"

function AppContent() {
  const [currentView, setCurrentView] = React.useState("chat")
  const { isAuthenticated, isLoading } = useAuth()

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
      {currentView === "chat" && <Chat />}
      {currentView === "files" && (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          Files view coming soon
        </div>
      )}
      {currentView === "commands" && (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          Commands view coming soon
        </div>
      )}
      {currentView === "settings" && <Settings />}
    </Layout>
  )
}

export function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <AppContent />
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>
  )
}

export default App

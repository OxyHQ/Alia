import * as React from "react"
import { Layout } from "@/components/Layout"
import { Chat } from "@/components/Chat"
import { TooltipProvider } from "@/components/ui/tooltip"

export function App() {
  const [currentView, setCurrentView] = React.useState("chat")

  return (
    <TooltipProvider>
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
      </Layout>
    </TooltipProvider>
  )
}

export default App

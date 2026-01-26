import * as React from "react"

interface LogEntry {
  timestamp: Date
  level: "info" | "warn" | "error"
  message: string
}

interface ConsoleContextType {
  logs: LogEntry[]
  addLog: (level: LogEntry["level"], message: string) => void
  clearLogs: () => void
}

const ConsoleContext = React.createContext<ConsoleContextType | undefined>(undefined)

export function ConsoleProvider({ children }: { children: React.ReactNode }) {
  const [logs, setLogs] = React.useState<LogEntry[]>([])

  const addLog = React.useCallback((level: LogEntry["level"], message: string) => {
    setLogs((prev) => [...prev, { timestamp: new Date(), level, message }].slice(-100))
  }, [])

  const clearLogs = React.useCallback(() => {
    setLogs([])
  }, [])

  // Listen to all events in the background
  React.useEffect(() => {
    // Chat events
    const unsubStart = window.api?.onChatStart(() => {
      addLog("info", "Chat started - sending message to API")
    })

    const unsubStream = window.api?.onChatStream((data) => {
      addLog("info", `Streaming: ${data.content.substring(0, 50)}${data.content.length > 50 ? "..." : ""}`)
    })

    const unsubEnd = window.api?.onChatEnd(() => {
      addLog("info", "Chat ended - response complete")
    })

    const unsubError = window.api?.onChatError((data) => {
      addLog("error", `Chat error: ${data.message}`)
    })

    const unsubTool = window.api?.onChatTool((data) => {
      addLog("info", `Tool ${data.status}: ${data.tool}`)
    })

    const unsubToolResult = window.api?.onChatToolResult((data) => {
      addLog(data.success ? "info" : "error", `Tool result (${data.tool}): ${data.success ? "success" : "failed"}`)
    })

    // Auth events
    const unsubAuthSuccess = window.api?.onAuthSuccess(() => {
      addLog("info", "Authentication successful")
    })

    const unsubAuthError = window.api?.onAuthError((data) => {
      addLog("error", `Auth error: ${data.message}`)
    })

    const unsubAuthSignedOut = window.api?.onAuthSignedOut(() => {
      addLog("info", "Signed out")
    })

    return () => {
      unsubStart?.()
      unsubStream?.()
      unsubEnd?.()
      unsubError?.()
      unsubTool?.()
      unsubToolResult?.()
      unsubAuthSuccess?.()
      unsubAuthError?.()
      unsubAuthSignedOut?.()
    }
  }, [addLog])

  const value = React.useMemo(
    () => ({
      logs,
      addLog,
      clearLogs,
    }),
    [logs, addLog, clearLogs]
  )

  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>
}

export function useConsole() {
  const context = React.useContext(ConsoleContext)
  if (context === undefined) {
    throw new Error("useConsole must be used within a ConsoleProvider")
  }
  return context
}

export type { LogEntry }

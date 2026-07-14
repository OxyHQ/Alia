import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { RefreshIcon, Copy01Icon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { useConsole } from "@/contexts/ConsoleContext"

export function Console() {
  const { logs, addLog, clearLogs: clearConsoleLogs } = useConsole()
  const [authState, setAuthState] = React.useState<{ isAuthenticated: boolean; apiKey?: string } | null>(null)
  const [apiTest, setApiTest] = React.useState<{ status: string; message: string } | null>(null)

  // Fetch auth state
  React.useEffect(() => {
    window.api?.getAuthState().then(setAuthState)
  }, [])

  const testApiConnection = async () => {
    addLog("info", "Testing API connection...")
    setApiTest({ status: "testing", message: "Connecting to API..." })

    try {
      const response = await fetch("https://api.alia.onl/v1/models")
      if (response.ok) {
        const data = await response.json()
        setApiTest({ status: "success", message: `Connected! Found ${data.data?.length || 0} models` })
        addLog("info", `API test successful: ${data.data?.length || 0} models available`)
      } else {
        setApiTest({ status: "error", message: `HTTP ${response.status}: ${response.statusText}` })
        addLog("error", `API test failed: HTTP ${response.status}`)
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Connection failed"
      setApiTest({ status: "error", message })
      addLog("error", `API test error: ${message}`)
    }
  }

  const copyLogs = () => {
    const logsText = logs
      .map((log) => `[${log.timestamp.toISOString()}] ${log.level.toUpperCase()}: ${log.message}`)
      .join("\n")
    navigator.clipboard.writeText(logsText)
    addLog("info", "Logs copied to clipboard")
  }

  const handleClearLogs = () => {
    clearConsoleLogs()
  }

  return (
    <div className="flex-1 overflow-auto min-h-0">
      <div className="container max-w-4xl py-8 px-6">
        <div className="space-y-6">
          {/* Header */}
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Console & Debug</h1>
            <p className="text-muted-foreground mt-2">
              Debug information and system diagnostics
            </p>
          </div>

          <Separator />

          {/* Authentication Status */}
          <Card>
            <CardHeader>
              <CardTitle>Authentication</CardTitle>
              <CardDescription>Current authentication state</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Status</Label>
                <span className={cn(
                  "text-sm font-medium px-2 py-1 rounded",
                  authState?.isAuthenticated
                    ? "bg-green-500/10 text-green-500"
                    : "bg-destructive/10 text-destructive"
                )}>
                  {authState?.isAuthenticated ? "Authenticated" : "Not Authenticated"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <Label>API Key</Label>
                <code className="text-xs text-muted-foreground font-mono">
                  {authState?.apiKey
                    ? `${authState.apiKey.substring(0, 20)}...`
                    : "Not set"}
                </code>
              </div>
            </CardContent>
          </Card>

          {/* API Connection Test */}
          <Card>
            <CardHeader>
              <CardTitle>API Connection</CardTitle>
              <CardDescription>Test connection to api.alia.onl</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <Button onClick={testApiConnection} variant="outline" size="sm">
                  <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} className="size-4 mr-2" />
                  Test Connection
                </Button>
                {apiTest && (
                  <span className={cn(
                    "text-sm",
                    apiTest.status === "success" && "text-green-500",
                    apiTest.status === "error" && "text-destructive",
                    apiTest.status === "testing" && "text-muted-foreground"
                  )}>
                    {apiTest.message}
                  </span>
                )}
              </div>
              <div className="space-y-1 text-xs text-muted-foreground">
                <div>Base URL: https://api.alia.onl</div>
                <div>Auth URL: https://alia.onl/authorize/codea</div>
                <div>Model: alia-v1-codea</div>
              </div>
            </CardContent>
          </Card>

          {/* System Information */}
          <Card>
            <CardHeader>
              <CardTitle>System Information</CardTitle>
              <CardDescription>Platform and environment details</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Platform</span>
                <span className="font-mono">{navigator.platform}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">User Agent</span>
                <span className="font-mono text-xs">{navigator.userAgent.split(" ")[0]}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Language</span>
                <span className="font-mono">{navigator.language}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Online</span>
                <span className="font-mono">{navigator.onLine ? "Yes" : "No"}</span>
              </div>
            </CardContent>
          </Card>

          {/* Console Logs */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Console Logs</CardTitle>
                  <CardDescription>Application event log</CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button onClick={copyLogs} variant="outline" size="sm" disabled={logs.length === 0}>
                    <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} className="size-4" />
                  </Button>
                  <Button onClick={handleClearLogs} variant="outline" size="sm" disabled={logs.length === 0}>
                    Clear
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[300px] w-full rounded-md border bg-muted/20 p-4">
                {logs.length === 0 ? (
                  <div className="text-center text-sm text-muted-foreground py-8">
                    No logs yet. Try testing the API connection or using the app.
                  </div>
                ) : (
                  <div className="space-y-1 font-mono text-xs">
                    {logs.map((log, i) => (
                      <div key={i} className="flex gap-2">
                        <span className="text-muted-foreground shrink-0">
                          {log.timestamp.toLocaleTimeString()}
                        </span>
                        <span className={cn(
                          "shrink-0 uppercase w-12",
                          log.level === "error" && "text-destructive",
                          log.level === "warn" && "text-yellow-500",
                          log.level === "info" && "text-blue-500"
                        )}>
                          {log.level}
                        </span>
                        <span>{log.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

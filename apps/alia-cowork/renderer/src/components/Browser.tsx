import * as React from "react"

export function Browser() {
  const [screenshot, setScreenshot] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    // Handle screenshot updates from main process
    const handlePreview = (_: any, data: { screenshot: string }) => {
      setScreenshot(data.screenshot)
      setIsLoading(false)
      setError(null)
    }

    const handleError = (_: any, data: { error: string }) => {
      setError(data.error)
      setIsLoading(false)
    }

    const handleClosed = () => {
      setScreenshot(null)
      setIsLoading(true)
      setError(null)
    }

    window.electron.on('browser:preview', handlePreview)
    window.electron.on('browser:error', handleError)
    window.electron.on('browser:closed', handleClosed)

    return () => {
      window.electron.off('browser:preview', handlePreview)
      window.electron.off('browser:error', handleError)
      window.electron.off('browser:closed', handleClosed)
    }
  }, [])

  return (
    <div className="flex-1 flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-sm font-medium">Browser</span>
        </div>
        <span className="text-xs text-muted-foreground">
          AI is controlling the browser
        </span>
      </div>

      {/* Browser Preview */}
      <div className="flex-1 flex items-center justify-center overflow-hidden p-4">
        {isLoading && !screenshot && !error && (
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <p className="text-sm">Loading browser...</p>
          </div>
        )}

        {error && (
          <div className="flex flex-col items-center gap-3 text-destructive max-w-md text-center">
            <svg
              className="w-12 h-12"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <div>
              <p className="font-medium">Browser Error</p>
              <p className="text-sm text-muted-foreground mt-1">{error}</p>
            </div>
          </div>
        )}

        {screenshot && !error && (
          <div className="w-full h-full flex items-center justify-center">
            <img
              src={screenshot}
              alt="Browser preview"
              className="max-w-full max-h-full object-contain rounded-lg shadow-lg border border-border"
              style={{ imageRendering: 'crisp-edges' }}
            />
          </div>
        )}

        {!isLoading && !screenshot && !error && (
          <div className="text-center text-muted-foreground">
            <p>Browser preview will appear here</p>
          </div>
        )}
      </div>

      {/* Footer hint */}
      <div className="px-4 py-2 border-t border-border bg-muted/20">
        <p className="text-xs text-muted-foreground text-center">
          The AI will automatically return to chat when done
        </p>
      </div>
    </div>
  )
}

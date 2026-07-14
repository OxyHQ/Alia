import * as React from "react"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { useAuth } from "@/contexts/AuthContext"
import { HugeiconsIcon } from "@hugeicons/react"
import { SparklesIcon, MinusSignIcon, Cancel01Icon } from "@hugeicons/core-free-icons"

export function SignIn() {
  const { signIn } = useAuth()
  const [isSigningIn, setIsSigningIn] = React.useState(false)

  const handleSignIn = async () => {
    setIsSigningIn(true)
    try {
      await signIn()
    } catch (error) {
      console.error("Sign in failed:", error)
    } finally {
      setIsSigningIn(false)
    }
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-background">
      {/* Title Bar */}
      <div className="flex items-center justify-between h-10 px-2 border-b bg-background/80 backdrop-blur shrink-0">
        <div className="flex items-center gap-2 px-2">
          <Avatar size="sm" className="size-5">
            <AvatarImage src="icon.png" alt="OxyAI" />
            <AvatarFallback>AI</AvatarFallback>
          </Avatar>
          <span className="text-sm font-semibold">OxyAI Cowork</span>
        </div>

        {/* Draggable spacer */}
        <div className="flex-1 h-full app-drag" />

        {/* Window Controls */}
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-8" onClick={() => window.api?.minimize()}>
            <HugeiconsIcon icon={MinusSignIcon} strokeWidth={2} className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-8 hover:bg-destructive hover:text-destructive-foreground" onClick={() => window.api?.close()}>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-col items-center justify-center flex-1 w-full p-6 gap-6 bg-gradient-to-br from-background to-muted/20">
        <div className="flex flex-col items-center gap-4 text-center max-w-sm">
          <div className="size-16 rounded-full bg-primary/10 flex items-center justify-center">
            <HugeiconsIcon icon={SparklesIcon} className="size-8 text-primary" strokeWidth={2} />
          </div>

          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              Welcome to OxyAI Cowork
            </h1>
            <p className="text-sm text-muted-foreground">
              Connect your OxyAI account to start using AI-powered automation on your computer
            </p>
          </div>

          <Button
            size="lg"
            className="w-full mt-4"
            onClick={handleSignIn}
            disabled={isSigningIn}
          >
            {isSigningIn ? "Opening browser..." : "Connect to OxyAI"}
          </Button>

          <p className="text-xs text-muted-foreground mt-2">
            You'll sign in with Oxy and authorize access
          </p>
        </div>
      </div>
    </div>
  )
}

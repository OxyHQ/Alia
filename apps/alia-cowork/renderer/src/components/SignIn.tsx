import * as React from "react"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/contexts/AuthContext"
import { HugeiconsIcon } from "@hugeicons/react"
import { SparklesIcon } from "@hugeicons/core-free-icons"

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
    <div className="flex flex-col items-center justify-center h-full w-full p-6 gap-6 bg-gradient-to-br from-background to-muted/20">
      <div className="flex flex-col items-center gap-4 text-center max-w-sm">
        <div className="size-16 rounded-full bg-primary/10 flex items-center justify-center">
          <HugeiconsIcon icon={SparklesIcon} className="size-8 text-primary" strokeWidth={2} />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            Welcome to Alia Cowork
          </h1>
          <p className="text-sm text-muted-foreground">
            Connect your Alia account to start using AI-powered automation on your computer
          </p>
        </div>

        <Button
          size="lg"
          className="w-full mt-4"
          onClick={handleSignIn}
          disabled={isSigningIn}
        >
          {isSigningIn ? "Opening browser..." : "Connect to Alia"}
        </Button>

        <p className="text-xs text-muted-foreground mt-2">
          You'll sign in with Oxy and authorize access
        </p>
      </div>
    </div>
  )
}

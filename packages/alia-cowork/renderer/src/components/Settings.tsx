import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Moon02Icon, Sun03Icon, ComputerIcon } from "@hugeicons/core-free-icons"
import { useAuth } from "@/contexts/AuthContext"
import { useTheme } from "@/contexts/ThemeContext"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"

export function Settings() {
  const { user, signOut } = useAuth()
  const { theme, setTheme, effectiveTheme } = useTheme()

  const themeOptions = [
    { value: "light" as const, label: "Light", icon: Sun03Icon },
    { value: "dark" as const, label: "Dark", icon: Moon02Icon },
    { value: "system" as const, label: "System", icon: ComputerIcon },
  ]

  return (
    <div className="flex-1 overflow-auto min-h-0">
      <div className="container max-w-4xl py-8 px-6">
        <div className="space-y-6">
          {/* Header */}
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
            <p className="text-muted-foreground mt-2">
              Manage your preferences and account settings
            </p>
          </div>

          <Separator />

          {/* Appearance */}
          <Card>
            <CardHeader>
              <CardTitle>Appearance</CardTitle>
              <CardDescription>
                Customize how Alia Cowork looks on your device
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Theme</Label>
                <div className="flex gap-3">
                  {themeOptions.map((option) => (
                    <Button
                      key={option.value}
                      variant={theme === option.value ? "default" : "outline"}
                      className="flex-1 gap-2"
                      onClick={() => setTheme(option.value)}
                    >
                      <HugeiconsIcon icon={option.icon} strokeWidth={2} className="size-4" />
                      {option.label}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Current: {effectiveTheme === "dark" ? "Dark" : "Light"}
                  {theme === "system" && " (System)"}
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Account */}
          {user && (
            <Card>
              <CardHeader>
                <CardTitle>Account</CardTitle>
                <CardDescription>
                  Manage your Alia account settings
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Email</Label>
                  <div className="text-sm text-muted-foreground">
                    {user.email || "Not available"}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>User ID</Label>
                  <div className="text-sm text-muted-foreground font-mono">
                    {user.id}
                  </div>
                </div>

                <Separator />

                <div>
                  <Button variant="destructive" onClick={signOut}>
                    Sign Out
                  </Button>
                  <p className="text-xs text-muted-foreground mt-2">
                    You'll need to sign in again to use Alia Cowork
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* About */}
          <Card>
            <CardHeader>
              <CardTitle>About</CardTitle>
              <CardDescription>
                Application information
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50">
                <Avatar size="lg" className="size-12 rounded-lg">
                  <AvatarImage src="icon.png" alt="Alia" />
                  <AvatarFallback>AI</AvatarFallback>
                </Avatar>
                <div>
                  <div className="font-semibold">Alia Cowork</div>
                  <div className="text-sm text-muted-foreground">Made with ❤️ in the 🌎 by Oxy</div>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Version</Label>
                <div className="text-sm text-muted-foreground">1.0.0</div>
              </div>

              <div className="space-y-2">
                <Label>Platform</Label>
                <div className="text-sm text-muted-foreground capitalize">
                  {navigator.platform}
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <Button
                  variant="outline"
                  onClick={() => window.open('https://docs.alia.onl', '_blank')}
                >
                  Documentation
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

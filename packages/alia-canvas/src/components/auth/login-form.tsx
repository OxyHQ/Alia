import { useState } from "react";
import { useAuth } from "@oxyhq/services";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function LoginForm() {
  const { signIn } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSignIn = async () => {
    setError("");
    setIsLoading(true);

    try {
      await signIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Welcome to Alia Canvas</CardTitle>
          <CardDescription>
            Sign in with your Oxy account to access Canvas
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950/20 p-3 rounded-md">
              {error}
            </div>
          )}
          <Button
            onClick={handleSignIn}
            className="w-full"
            disabled={isLoading}
          >
            {isLoading ? "Signing in..." : "Sign In with Oxy"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Login Page
 * Uses OxyHQ authentication via the useAuth hook
 */

import { useAuth } from '@oxyhq/auth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Server, LogIn } from 'lucide-react';

export function LoginPage() {
  const { isLoading, signIn } = useAuth();

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-4">
          <div className="flex items-center justify-center gap-3">
            <Server className="h-8 w-8 text-primary" />
            <div className="text-center">
              <CardTitle className="text-2xl">Alia Providers</CardTitle>
              <CardDescription>Admin Panel</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground text-center">
              Sign in with your Oxy account to access the admin panel
            </p>
          </div>

          <div className="flex justify-center">
            <Button
              onClick={() => signIn()}
              disabled={isLoading}
              size="lg"
              className="w-full"
            >
              <LogIn className="mr-2 h-5 w-5" />
              {isLoading ? 'Signing in...' : 'Sign in with Oxy'}
            </Button>
          </div>

          <div className="text-xs text-muted-foreground text-center">
            <p>Admin access is restricted to authorized users only.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

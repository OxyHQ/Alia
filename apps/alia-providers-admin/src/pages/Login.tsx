/**
 * Login Page
 * Uses OxyHQ's OxySignInButton for authentication
 */

import { OxySignInButton } from '@oxyhq/services';
import { useAuth } from '@/lib/auth/context';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Server, AlertTriangle } from 'lucide-react';

export function LoginPage() {
  const { error, loading } = useAuth();

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
            {error && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>

          <div className="flex justify-center">
            <OxySignInButton disabled={loading} />
          </div>

          <div className="text-xs text-muted-foreground text-center space-y-1">
            <p>Admin access is restricted to authorized users only.</p>
            <p className="text-primary">Only username "nate" has access.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

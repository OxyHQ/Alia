"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Monitor } from "lucide-react";

export function DesktopOnlyGuard({ children }: { children: React.ReactNode }) {
  const [isDesktop, setIsDesktop] = useState(true);

  useEffect(() => {
    const checkScreenSize = () => {
      setIsDesktop(window.innerWidth >= 1024);
    };

    checkScreenSize();
    window.addEventListener("resize", checkScreenSize);

    return () => window.removeEventListener("resize", checkScreenSize);
  }, []);

  if (!isDesktop) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-background p-6">
        <div className="max-w-md text-center space-y-6">
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <Monitor className="w-8 h-8 text-primary" />
            </div>
          </div>

          <div className="space-y-2">
            <h1 className="text-2xl font-bold">Desktop Only</h1>
            <p className="text-muted-foreground">
              Canvas is designed for desktop screens. Please access this app from a desktop browser
              for the best experience.
            </p>
          </div>

          <Button
            onClick={() => {
              window.location.href = "/";
            }}
            size="lg"
          >
            Go to Main App
          </Button>

          <p className="text-xs text-muted-foreground">
            Powered by Oxy
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

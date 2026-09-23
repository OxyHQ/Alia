import React from "react";
import { useAppNav } from "@/components/app-shell/nav-context";
import { useUIStore } from "@/lib/stores/ui-store";

export function useSidebarCollapse() {
  const nav = useAppNav();
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);

  const collapsed = nav.inFlow && !sidebarOpen;

  const collapse = React.useCallback(() => {
    if (nav.inFlow) {
      setSidebarOpen(false);
    } else {
      nav.close();
    }
  }, [nav, setSidebarOpen]);

  const expand = React.useCallback(() => {
    setSidebarOpen(true);
  }, [setSidebarOpen]);

  return { collapsed, collapse, expand };
}

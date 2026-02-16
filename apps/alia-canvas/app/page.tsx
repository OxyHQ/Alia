import { WorkflowEditor } from "@/components/workflow/workflow-editor";
import { DesktopOnlyGuard } from "@/components/desktop-only-guard";
import { AuthGuard } from "@/components/auth-guard";

export default function Page() {
  return (
    <AuthGuard>
      <DesktopOnlyGuard>
        <WorkflowEditor />
      </DesktopOnlyGuard>
    </AuthGuard>
  );
}

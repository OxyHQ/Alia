import { WorkflowEditor } from "@/components/workflow/workflow-editor";
import { DesktopOnlyGuard } from "@/components/desktop-only-guard";

export default function Page() {
  return (
    <DesktopOnlyGuard>
      <WorkflowEditor />
    </DesktopOnlyGuard>
  );
}

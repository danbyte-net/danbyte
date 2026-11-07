import { Badge } from "@/components/ui/badge"
import type { DeployRun } from "@/lib/api"

// "launched" means handed to the runner; a script target or a runner
// callback moves it on to "succeeded" or "failed".
const VARIANT: Record<
  DeployRun["status"],
  "secondary" | "info" | "success" | "destructive"
> = {
  queued: "secondary",
  launched: "info",
  succeeded: "success",
  failed: "destructive",
}

export function DeployRunStatus({ status }: { status: DeployRun["status"] }) {
  return (
    <Badge variant={VARIANT[status]} className="text-[10px]">
      {status}
    </Badge>
  )
}

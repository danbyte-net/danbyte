import { Badge } from "@/components/ui/badge"
import type { DeployRun } from "@/lib/api"

const VARIANT: Record<
  DeployRun["status"],
  "secondary" | "success" | "destructive"
> = {
  queued: "secondary",
  launched: "success",
  failed: "destructive",
}

export function DeployRunStatus({ status }: { status: DeployRun["status"] }) {
  return (
    <Badge variant={VARIANT[status]} className="text-[10px]">
      {status}
    </Badge>
  )
}

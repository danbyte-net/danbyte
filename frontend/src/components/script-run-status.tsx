import type { ScriptRunStatus } from "@/lib/api"
import { Badge } from "@/components/ui/badge"

const LABEL: Record<ScriptRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  success: "Success",
  failed: "Failed",
  timeout: "Timed out",
  canceled: "Canceled",
}

const VARIANT: Record<
  ScriptRunStatus,
  "secondary" | "warning" | "success" | "destructive"
> = {
  queued: "secondary",
  running: "warning",
  success: "success",
  failed: "destructive",
  timeout: "destructive",
  canceled: "secondary",
}

export function RunStatusBadge({ status }: { status: ScriptRunStatus }) {
  return <Badge variant={VARIANT[status]}>{LABEL[status]}</Badge>
}

export const isRunActive = (s: ScriptRunStatus) =>
  s === "queued" || s === "running"

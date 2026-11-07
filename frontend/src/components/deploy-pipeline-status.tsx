import { Badge } from "@/components/ui/badge"
import type {
  DeployPipelineRunStatus,
  DeployPipelineRunStep,
  DeployPipelineStepStatus,
} from "@/lib/api"
import { cn } from "@/lib/utils"

type Variant = "secondary" | "info" | "success" | "warning" | "destructive"

// One variant per status, shared by a run's badge and its numbered step
// badges, so a run row and its run page read the same.
const VARIANT: Record<
  DeployPipelineRunStatus | DeployPipelineStepStatus,
  Variant
> = {
  pending: "secondary",
  queued: "secondary",
  running: "warning",
  succeeded: "success",
  failed: "destructive",
  skipped: "secondary",
  cancelled: "secondary",
}

const LABEL: Record<
  DeployPipelineRunStatus | DeployPipelineStepStatus,
  string
> = {
  pending: "Pending",
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
}

export function pipelineStatusVariant(
  s: DeployPipelineRunStatus | DeployPipelineStepStatus
): Variant {
  return VARIANT[s]
}

export function pipelineStatusLabel(
  s: DeployPipelineRunStatus | DeployPipelineStepStatus
): string {
  return LABEL[s]
}

export function isPipelineRunActive(s: DeployPipelineRunStatus): boolean {
  return s === "queued" || s === "running"
}

export function PipelineStatusBadge({
  status,
  className,
}: {
  status: DeployPipelineRunStatus | DeployPipelineStepStatus
  className?: string
}) {
  return (
    <Badge
      variant={pipelineStatusVariant(status)}
      className={cn("text-[10px]", className)}
    >
      {pipelineStatusLabel(status)}
    </Badge>
  )
}

/** One small numbered badge per step, each in its status variant. */
export function PipelineStepBadges({
  steps,
}: {
  steps: Pick<DeployPipelineRunStep, "step" | "status" | "target_name">[]
}) {
  const label = steps
    .map((s) => `step ${s.step} ${pipelineStatusLabel(s.status).toLowerCase()}`)
    .join(", ")
  return (
    <span className="flex items-center gap-1" role="img" aria-label={label}>
      {steps.map((s) => (
        <Badge
          key={s.step}
          variant={pipelineStatusVariant(s.status)}
          className="num min-w-5 justify-center px-1 text-[10px]"
        >
          {s.step}
        </Badge>
      ))}
    </span>
  )
}

import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { DeployPipelineRun } from "@/lib/api"
import { SortHeader } from "@/components/data-table"
import { TimeCell } from "@/components/cells/time-ago"
import { Badge } from "@/components/ui/badge"
import {
  PipelineStatusBadge,
  PipelineStepBadges,
} from "@/components/deploy-pipeline-status"
import { formatDeployDuration } from "@/components/columns/deploy-run-columns"

// The one table of pipeline runs: the Pipelines page and a pipeline's Runs
// tab both build their columns here (the pipeline's own tab omits
// "pipeline").

export type DeployPipelineRunColumnId =
  "run" | "pipeline" | "objects" | "steps" | "trigger" | "duration" | "created"

const ORDER: DeployPipelineRunColumnId[] = [
  "run",
  "pipeline",
  "objects",
  "steps",
  "trigger",
  "duration",
  "created",
]

export function runLabel(r: Pick<DeployPipelineRun, "numid" | "id">): string {
  return r.numid != null ? `#${r.numid}` : r.id.slice(0, 8)
}

export function runObjectsLabel(r: DeployPipelineRun): string {
  const n = r.object_ids.length
  if (n === 1 && r.objects[0]) return r.objects[0].name
  const noun = r.object_type === "virtualmachine" ? "VM" : "device"
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}

export function runTriggerLabel(r: DeployPipelineRun): string {
  if (r.trigger === "rerun")
    return r.rerun_of_numid != null
      ? `Re-run of #${r.rerun_of_numid}`
      : "Re-run"
  return r.triggered_by_name
    ? `${r.trigger_display} · ${r.triggered_by_name}`
    : r.trigger_display
}

export function buildDeployPipelineRunColumns(
  opts: { omit?: DeployPipelineRunColumnId[] } = {}
): ColumnDef<DeployPipelineRun, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const byId: Record<
    DeployPipelineRunColumnId,
    () => ColumnDef<DeployPipelineRun, unknown>
  > = {
    run: () => ({
      id: "run",
      accessorFn: (r) => r.numid ?? 0,
      header: ({ column }) => <SortHeader column={column} label="Run" />,
      cell: ({ row }) => {
        const r = row.original
        const why = r.failing_step
        return (
          <div className="min-w-0">
            <Link
              to="/pipelines/runs/$runId"
              params={{ runId: r.id }}
              className="flex items-center gap-2 font-medium hover:underline"
            >
              <span className="num">{runLabel(r)}</span>
              <PipelineStatusBadge status={r.status} />
              {r.dry_run && (
                <Badge variant="outline" className="text-[10px]">
                  Dry run
                </Badge>
              )}
            </Link>
            {why && why.error && (
              <div className="mt-1 line-clamp-1 text-xs text-destructive">
                {why.step != null
                  ? `Step ${why.step} ${why.target_name}: `
                  : ""}
                {why.error}
              </div>
            )}
          </div>
        )
      },
    }),
    pipeline: () => ({
      id: "pipeline",
      accessorKey: "pipeline_name",
      header: ({ column }) => <SortHeader column={column} label="Pipeline" />,
      cell: ({ row }) =>
        row.original.pipeline ? (
          <Link
            to="/pipelines/$id"
            params={{ id: row.original.pipeline }}
            className="link"
          >
            {row.original.pipeline_name}
          </Link>
        ) : (
          <span>{row.original.pipeline_name}</span>
        ),
    }),
    objects: () => ({
      id: "objects",
      header: "Devices",
      cell: ({ row }) => (
        <span className="font-mono text-[12px]">
          {runObjectsLabel(row.original)}
        </span>
      ),
    }),
    steps: () => ({
      id: "steps",
      header: "Steps",
      enableSorting: false,
      cell: ({ row }) => <PipelineStepBadges steps={row.original.steps} />,
    }),
    trigger: () => ({
      id: "trigger",
      header: "Trigger",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {runTriggerLabel(row.original)}
        </span>
      ),
    }),
    duration: () => ({
      id: "duration",
      accessorFn: (r) => r.duration_ms ?? -1,
      header: ({ column }) => <SortHeader column={column} label="Duration" />,
      cell: ({ row }) => (
        <span className="num text-xs text-muted-foreground">
          {row.original.duration_ms != null
            ? formatDeployDuration(row.original.duration_ms)
            : "-"}
        </span>
      ),
    }),
    created: () => ({
      id: "created",
      accessorKey: "created_at",
      header: ({ column }) => <SortHeader column={column} label="When" />,
      cell: ({ row }) => (
        <TimeCell iso={row.original.created_at} align="right" />
      ),
    }),
  }
  return ORDER.filter((id) => !omit.has(id)).map((id) => byId[id]())
}

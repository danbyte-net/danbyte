import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { DeployPipeline } from "@/lib/api"
import { SortHeader } from "@/components/data-table"
import { TimeCell } from "@/components/cells/time-ago"
import { ColorBadge } from "@/components/cells/color-badge"
import { dash } from "@/components/cells/dash"
import { Badge } from "@/components/ui/badge"
import {
  PipelineStatusBadge,
  pipelineAppliesLabel,
} from "@/components/deploy-pipeline-status"

// The one table of pipelines - the Pipelines page builds its columns here.

export type DeployPipelineColumnId =
  "name" | "applies" | "steps" | "roles" | "trigger" | "last_run"

const ORDER: DeployPipelineColumnId[] = [
  "name",
  "applies",
  "steps",
  "roles",
  "trigger",
  "last_run",
]

export function buildDeployPipelineColumns(
  opts: { omit?: DeployPipelineColumnId[] } = {}
): ColumnDef<DeployPipeline, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const byId: Record<
    DeployPipelineColumnId,
    () => ColumnDef<DeployPipeline, unknown>
  > = {
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-2">
          <Link
            to="/pipelines/$id"
            params={{ id: row.original.id }}
            className="link truncate font-medium"
          >
            {row.original.name}
          </Link>
          {!row.original.enabled && (
            <Badge variant="secondary" className="text-[10px]">
              Disabled
            </Badge>
          )}
        </span>
      ),
    }),
    applies: () => ({
      id: "applies",
      accessorFn: (p) => pipelineAppliesLabel(p),
      header: ({ column }) => <SortHeader column={column} label="Applies to" />,
      cell: ({ row }) => (
        <span className="text-xs whitespace-nowrap">
          {pipelineAppliesLabel(row.original)}
        </span>
      ),
    }),
    steps: () => ({
      id: "steps",
      accessorKey: "steps_count",
      header: ({ column }) => <SortHeader column={column} label="Steps" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.steps_count}</span>
      ),
    }),
    roles: () => ({
      id: "roles",
      header: "Default for",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.role_details.length ? (
          <span className="flex flex-wrap gap-1">
            {row.original.role_details.map((r) => (
              <ColorBadge
                key={r.id}
                name={r.name}
                color={r.color || undefined}
              />
            ))}
          </span>
        ) : (
          dash
        ),
    }),
    trigger: () => ({
      id: "trigger",
      accessorFn: (p) => (p.auto_on_change ? 1 : 0),
      header: ({ column }) => <SortHeader column={column} label="Trigger" />,
      cell: ({ row }) =>
        row.original.auto_on_change ? (
          <Badge variant="info" className="text-[10px]">
            Deploy or change
          </Badge>
        ) : (
          <Badge variant="secondary" className="text-[10px]">
            Deploy
          </Badge>
        ),
    }),
    last_run: () => ({
      id: "last_run",
      accessorFn: (p) => p.last_run?.created_at ?? "",
      header: ({ column }) => <SortHeader column={column} label="Last run" />,
      cell: ({ row }) => {
        const r = row.original.last_run
        if (!r) return dash
        return (
          <Link
            to="/pipelines/runs/$runId"
            params={{ runId: r.id }}
            className="flex items-center justify-end gap-2"
          >
            <PipelineStatusBadge status={r.status} />
            <TimeCell iso={r.created_at} />
          </Link>
        )
      },
    }),
  }
  return ORDER.filter((id) => !omit.has(id)).map((id) => byId[id]())
}

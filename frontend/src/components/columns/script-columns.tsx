import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"
import { CalendarClock, ShieldCheck } from "lucide-react"

import type { Script } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader } from "@/components/data-table"
import { TimeCell } from "@/components/cells/time-ago"
import { RunStatusBadge } from "@/components/script-run-status"

export type ScriptColumnId =
  | "name"
  | "description"
  | "visibility"
  | "schedule"
  | "last_run"
  | "runs"
  | "owner"

const VISIBILITY_LABEL: Record<Script["visibility"], string> = {
  owner: "Only me",
  users: "Shared",
  groups: "Shared",
  global: "Everyone",
}

/** One factory for the list page and the embedded tables, per the shared
 * column convention. */
export function buildScriptColumns(
  opts: { omit?: ScriptColumnId[] } = {}
): ColumnDef<Script, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const all: Record<ScriptColumnId, () => ColumnDef<Script, unknown>> = {
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          <Link
            to="/scripts/$id"
            params={{ id: row.original.id }}
            className="link font-medium"
          >
            {row.original.name}
          </Link>
          {row.original.trusted && (
            <Badge variant="warning">
              <ShieldCheck /> Trusted
            </Badge>
          )}
          {!row.original.enabled && <Badge variant="outline">Disabled</Badge>}
        </span>
      ),
    }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.description}
        </span>
      ),
    }),
    visibility: () => ({
      id: "visibility",
      accessorKey: "visibility",
      header: "Visibility",
      meta: {
        facet: {
          kind: "enum" as const,
          label: "Visibility",
          get: (r: Script) => VISIBILITY_LABEL[r.visibility],
        },
      },
      cell: ({ row }) => (
        <Badge
          variant={row.original.visibility === "global" ? "info" : "secondary"}
        >
          {VISIBILITY_LABEL[row.original.visibility]}
        </Badge>
      ),
    }),
    schedule: () => ({
      id: "schedule",
      accessorKey: "cadence_label",
      header: "Schedule",
      cell: ({ row }) =>
        row.original.schedule_enabled && row.original.cadence_label ? (
          <span className="flex items-center gap-1.5 text-xs">
            <CalendarClock className="size-3.5 text-muted-foreground" />
            {row.original.cadence_label}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Manual</span>
        ),
    }),
    last_run: () => ({
      id: "last_run",
      accessorKey: "last_run_at",
      header: ({ column }) => <SortHeader column={column} label="Last run" />,
      cell: ({ row }) => {
        const run = row.original.last_run
        if (!run)
          return <span className="text-xs text-muted-foreground">Never</span>
        return (
          <span className="flex items-center gap-2">
            <RunStatusBadge status={run.status} />
            <TimeCell iso={run.created_at} />
          </span>
        )
      },
    }),
    runs: () => ({
      id: "runs",
      accessorKey: "run_count",
      header: ({ column }) => <SortHeader column={column} label="Runs" />,
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.run_count}</span>
      ),
    }),
    owner: () => ({
      id: "owner",
      accessorKey: "owner_name",
      header: "Owner",
      meta: {
        facet: {
          kind: "enum" as const,
          label: "Owner",
          get: (r: Script) => r.owner_name,
        },
      },
      cell: ({ row }) => row.original.owner_name ?? "",
    }),
  }
  const order: ScriptColumnId[] = [
    "name",
    "description",
    "visibility",
    "schedule",
    "last_run",
    "runs",
    "owner",
  ]
  return order.filter((id) => !omit.has(id)).map((id) => all[id]())
}

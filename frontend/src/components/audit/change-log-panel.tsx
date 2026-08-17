import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"
import { ChevronRight, Download } from "lucide-react"

import { api } from "@/lib/api"
import type {
  ChangeAction,
  ChangeLogEntry,
  FieldChange,
  Paginated,
} from "@/lib/api"
import { downloadBlob } from "@/lib/table-export"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { QueryError } from "@/components/query-error"
import { TimeCell } from "@/components/cells/time-ago"

const ACTION_VARIANT: Record<
  ChangeAction,
  "success" | "warning" | "destructive"
> = { create: "success", update: "warning", delete: "destructive" }

const COLUMNS: ColumnDef<ChangeLogEntry>[] = [
  {
    id: "when",
    accessorFn: (e) => e.timestamp,
    header: ({ column }) => <SortHeader column={column} label="When" />,
    cell: ({ row }) => (
      // Deep-link to the entry's detail page (full pre/post + diff).
      <Link
        to="/audit-log/$id"
        params={{ id: row.original.id }}
        className="link"
      >
        <TimeCell iso={row.original.timestamp} />
      </Link>
    ),
  },
  {
    id: "user",
    accessorFn: (e) => e.user_name || "system",
    header: ({ column }) => <SortHeader column={column} label="User" />,
    cell: ({ row }) => row.original.user_name || "system",
  },
  {
    id: "action",
    accessorKey: "action",
    header: ({ column }) => <SortHeader column={column} label="Action" />,
    cell: ({ row }) => (
      <Badge
        variant={ACTION_VARIANT[row.original.action]}
        className="capitalize"
      >
        {row.original.action_display}
      </Badge>
    ),
  },
  {
    id: "changes",
    enableSorting: false,
    header: "Changes",
    cell: ({ row }) => <ChangesCell e={row.original} />,
  },
]

/**
 * Per-object change history — drop into a detail-page "History" tab. Renders
 * the same table look as the global Audit log (When / User / Action / Changes
 * with an expandable field-level diff) and offers a CSV export of the object's
 * full history. Reads /api/changelog filtered to one object.
 */
export function ChangeLogPanel({
  objectType,
  objectId,
}: {
  objectType: string
  objectId: string
}) {
  const q = useQuery({
    queryKey: ["changelog", objectType, objectId],
    queryFn: () =>
      api<Paginated<ChangeLogEntry>>(
        `/api/changelog/?object_type=${objectType}&object_id=${objectId}`
      ),
    // History should always reflect the latest writes — refetch whenever the
    // tab is opened rather than honouring the global 30s staleTime.
    staleTime: 0,
    refetchOnMount: "always",
  })
  const rows = q.data?.results ?? []

  if (q.isError) return <QueryError error={q.error} />

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">
          {rows.length} change{rows.length === 1 ? "" : "s"}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={rows.length === 0}
          onClick={() => exportChangelogCsv(rows, objectType, objectId)}
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </Button>
      </div>

      {q.data && rows.length === 0 ? (
        <EmptyState title="No recorded changes for this object yet." />
      ) : (
        <DataTable
          data={rows}
          columns={COLUMNS}
          flexColumn="changes"
          embedded
        />
      )}
    </div>
  )
}

/** Field-level diff, revealed in place from the "Changes" cell — the same
 * treatment the global Audit log uses. */
function ChangesCell({ e }: { e: ChangeLogEntry }) {
  const [open, setOpen] = useState(false)
  const fields = Object.entries(e.changes)
  if (fields.length === 0)
    return <span className="text-muted-foreground">—</span>
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}
        />
        {fields.length} field{fields.length === 1 ? "" : "s"}
      </button>
      {open && (
        <table className="text-xs">
          <tbody>
            {fields.map(([f, c]) => (
              <tr key={f}>
                <td className="py-0.5 pr-4 align-top font-mono text-muted-foreground">
                  {f}
                </td>
                <td className="py-0.5 pr-2 align-top font-mono text-red-600 line-through dark:text-red-400">
                  <FieldVal value={c.old} label={c.old_label} />
                </td>
                <td className="py-0.5 pr-2 align-top text-muted-foreground">
                  →
                </td>
                <td className="py-0.5 align-top font-mono text-emerald-600 dark:text-emerald-400">
                  <FieldVal value={c.new} label={c.new_label} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** FK fields carry a server-resolved label (e.g. the VLAN name); show it with
 * the raw UUID kept muted beside it. */
function FieldVal({ value, label }: { value: unknown; label?: string }) {
  if (label) {
    return (
      <span>
        {label} <span className="text-muted-foreground/60">({fmt(value)})</span>
      </span>
    )
  }
  return <>{fmt(value)}</>
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "∅"
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

/** Summarise a field diff for a flat CSV cell. */
function diffText(c: FieldChange): string {
  const old = c.old_label ?? fmt(c.old)
  const next = c.new_label ?? fmt(c.new)
  return `${old} → ${next}`
}

function exportChangelogCsv(
  rows: ChangeLogEntry[],
  objectType: string,
  objectId: string
) {
  const header = ["timestamp", "user", "action", "object", "changes"]
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`
  const lines = [header.join(",")]
  for (const e of rows) {
    const changes = Object.entries(e.changes)
      .map(([f, c]) => `${f}: ${diffText(c)}`)
      .join("; ")
    lines.push(
      [e.timestamp, e.user_name || "system", e.action, e.object_repr, changes]
        .map((v) => esc(String(v)))
        .join(",")
    )
  }
  downloadBlob(
    `changelog-${objectType}-${objectId.slice(0, 8)}.csv`,
    "text/csv;charset=utf-8",
    lines.join("\n")
  )
}

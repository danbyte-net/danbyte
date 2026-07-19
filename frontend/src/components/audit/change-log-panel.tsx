import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
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
import { QueryError } from "@/components/query-error"
import { TimeCell } from "@/components/cells/time-ago"
import { useUserPrefs } from "@/lib/use-user-prefs"

const ACTION_VARIANT: Record<
  ChangeAction,
  "success" | "warning" | "destructive"
> = { create: "success", update: "warning", delete: "destructive" }

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
  const [open, setOpen] = useState<string | null>(null)
  const { values: displayPrefs } = useUserPrefs()
  const striped = displayPrefs.table_stripes === true

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

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <table
          className="w-full text-left text-[13px]"
          data-stripes={striped ? "on" : "off"}
        >
          <thead className="bg-muted/40 text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
            <tr>
              <th className="w-8 px-2 py-2" />
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Changes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((e, i) => (
              <Row
                key={e.id}
                e={e}
                open={open === e.id}
                onToggle={() => setOpen(open === e.id ? null : e.id)}
                striped={striped && i % 2 === 1}
              />
            ))}
            {q.data && rows.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-10 text-center text-sm text-muted-foreground"
                >
                  No recorded changes for this object yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Row({
  e,
  open,
  onToggle,
  striped,
}: {
  e: ChangeLogEntry
  open: boolean
  onToggle: () => void
  striped?: boolean
}) {
  const fields = Object.entries(e.changes)
  return (
    <>
      <tr
        className={
          striped ? "bg-muted/30 hover:bg-muted/60" : "hover:bg-muted/40"
        }
      >
        <td className="px-2 py-1.5">
          {fields.length > 0 && (
            <button
              type="button"
              onClick={onToggle}
              className="text-muted-foreground hover:text-foreground"
            >
              <ChevronRight
                className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}
              />
            </button>
          )}
        </td>
        <td className="px-3 py-1.5 whitespace-nowrap">
          {/* Deep-link to the entry's detail page (full pre/post + diff). */}
          <Link
            to="/audit-log/$id"
            params={{ id: e.id }}
            className="hover:underline"
          >
            <TimeCell iso={e.timestamp} />
          </Link>
        </td>
        <td className="px-3 py-1.5">{e.user_name || "system"}</td>
        <td className="px-3 py-1.5">
          <Badge variant={ACTION_VARIANT[e.action]} className="capitalize">
            {e.action_display}
          </Badge>
        </td>
        <td className="px-3 py-1.5 text-muted-foreground">
          {fields.length > 0
            ? `${fields.length} field${fields.length === 1 ? "" : "s"}`
            : "—"}
        </td>
      </tr>
      {open && fields.length > 0 && (
        <tr className="bg-muted/20">
          <td />
          <td colSpan={4} className="px-3 py-2">
            <table className="text-[12px]">
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
          </td>
        </tr>
      )}
    </>
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

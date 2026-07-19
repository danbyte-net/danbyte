import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { api } from "@/lib/api"
import type { ChangeAction, ChangeLogEntry, Paginated } from "@/lib/api"
import { objectDetailRoute } from "@/lib/object-routes"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { KvCard, mono, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/audit-log_/$id")({
  component: ChangeLogDetail,
})

const ACTION_VARIANT: Record<
  ChangeAction,
  "success" | "warning" | "destructive"
> = { create: "success", update: "warning", delete: "destructive" }

/**
 * One change-log entry in full (NetBox-style): the change's metadata, a
 * red/green Difference summary of exactly what changed, and the complete
 * Pre-/Post-Change row snapshots with the changed lines highlighted.
 */
function ChangeLogDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["changelog-entry", id],
    queryFn: () => api<ChangeLogEntry>(`/api/changelog/${id}/`),
  })

  // The same object's full history, for Previous / Next navigation between
  // its changes (newest first, mirroring the History tab ordering).
  const e = q.data
  const historyQ = useQuery({
    enabled: !!e,
    queryKey: ["changelog", e?.object_type, e?.object_id],
    queryFn: () =>
      api<Paginated<ChangeLogEntry>>(
        `/api/changelog/?object_type=${e!.object_type}&object_id=${e!.object_id}`
      ),
  })
  const history = historyQ.data?.results ?? []
  const idx = history.findIndex((h) => h.id === id)
  // List is newest-first: "previous" = the older change, "next" = the newer.
  const older = idx >= 0 ? history[idx + 1] : undefined
  const newer = idx > 0 ? history[idx - 1] : undefined

  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!e) return null

  const route =
    e.action !== "delete" ? objectDetailRoute(e.object_type) : undefined
  const changedFields = Object.keys(e.changes)

  const changeRows: KvRow[] = [
    {
      label: "Time",
      value: (
        <span className="num text-[13px]">
          {new Date(e.timestamp).toLocaleString()}
        </span>
      ),
    },
    { label: "User", value: e.user_name || "system" },
    {
      label: "Action",
      value: (
        <Badge variant={ACTION_VARIANT[e.action]} className="capitalize">
          {e.action_display}
        </Badge>
      ),
    },
    { label: "Object type", value: e.object_label },
    {
      label: "Object",
      value: route ? (
        <Link
          to={route}
          params={{ id: e.object_id }}
          className="font-medium text-primary hover:underline"
        >
          {e.object_repr}
        </Link>
      ) : (
        <span className="font-medium">{e.object_repr}</span>
      ),
    },
    {
      label: "Request ID",
      value: e.request_id ? mono(e.request_id) : dash,
      copy: e.request_id || undefined,
    },
  ]

  return (
    <div className="flex h-full flex-1 flex-col">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        <nav className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Button variant="ghost" size="sm" asChild className="h-6 px-1">
            <Link to="/audit-log">
              <ChevronLeft className="h-3 w-3" /> Audit log
            </Link>
          </Button>
          <ChevronRight className="h-3 w-3 opacity-60" />
          <span className="font-semibold tracking-tight text-foreground">
            {e.object_label} {e.object_repr}
          </span>
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            asChild={!!older}
            disabled={!older}
          >
            {older ? (
              <Link to="/audit-log/$id" params={{ id: older.id }}>
                <ChevronLeft className="h-3.5 w-3.5" /> Previous
              </Link>
            ) : (
              <span>
                <ChevronLeft className="h-3.5 w-3.5" /> Previous
              </span>
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            asChild={!!newer}
            disabled={!newer}
          >
            {newer ? (
              <Link to="/audit-log/$id" params={{ id: newer.id }}>
                Next <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            ) : (
              <span>
                Next <ChevronRight className="h-3.5 w-3.5" />
              </span>
            )}
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
        <div className="mx-auto max-w-7xl space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <KvCard title="Change" rows={changeRows} />
            <DifferenceCard e={e} labels={e.related_labels} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <SnapshotCard
              title="Pre-change data"
              data={e.pre_change ?? null}
              changed={changedFields}
              tone="removed"
              labels={e.related_labels}
              emptyText={
                e.action === "create"
                  ? "None — the object did not exist yet."
                  : "No snapshot recorded (entry predates snapshots)."
              }
            />
            <SnapshotCard
              title="Post-change data"
              data={e.post_change ?? null}
              changed={changedFields}
              tone="added"
              labels={e.related_labels}
              emptyText={
                e.action === "delete"
                  ? "None — the object was deleted."
                  : "No snapshot recorded (entry predates snapshots)."
              }
            />
          </div>
        </div>
      </div>
    </div>
  )
}

/** The red/green "what changed" summary. Updates show old vs new values of
 * the changed fields; creates show the new object, deletes the removed one. */
function DifferenceCard({
  e,
  labels,
}: {
  e: ChangeLogEntry
  labels?: Record<string, string>
}) {
  const fields = Object.entries(e.changes)
  const removed: Record<string, unknown> = {}
  const added: Record<string, unknown> = {}
  if (e.action === "update") {
    for (const [f, c] of fields) {
      removed[f] = c.old
      added[f] = c.new
    }
  }
  const removedData =
    e.action === "delete"
      ? (e.pre_change ?? null)
      : e.action === "update"
        ? removed
        : null
  const addedData =
    e.action === "create"
      ? (e.post_change ?? null)
      : e.action === "update"
        ? added
        : null

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
        Difference
      </h2>
      <div className="space-y-3">
        {removedData && Object.keys(removedData).length > 0 && (
          <DiffBlock data={removedData} tone="removed" labels={labels} />
        )}
        {addedData && Object.keys(addedData).length > 0 && (
          <DiffBlock data={addedData} tone="added" labels={labels} />
        )}
        {!removedData && !addedData && (
          <p className="text-[13px] text-muted-foreground">
            No field-level differences recorded.
          </p>
        )}
      </div>
    </section>
  )
}

const TONE = {
  removed: {
    block:
      "border-red-200 bg-red-50 text-red-900 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200",
    line: "bg-red-100/80 dark:bg-red-950/50",
  },
  added: {
    block:
      "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200",
    line: "bg-emerald-100/80 dark:bg-emerald-950/50",
  },
} as const

function DiffBlock({
  data,
  tone,
  labels,
}: {
  data: Record<string, unknown>
  tone: keyof typeof TONE
  labels?: Record<string, string>
}) {
  return (
    <div className={`rounded-lg border p-3 ${TONE[tone].block}`}>
      <dl className="space-y-0.5 font-mono text-[12px]">
        {Object.entries(data).map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="shrink-0">{k}:</dt>
            <dd className="min-w-0 break-all whitespace-pre-wrap">
              <FieldValue value={v} labels={labels} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** A full row snapshot, one `key: value` line per field, with the fields that
 * changed in this entry tinted red (pre) / green (post) — NetBox-style. */
function SnapshotCard({
  title,
  data,
  changed,
  tone,
  emptyText,
  labels,
}: {
  title: string
  data: Record<string, unknown> | null
  changed: string[]
  tone: keyof typeof TONE
  emptyText: string
  labels?: Record<string, string>
}) {
  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
        {title}
      </h2>
      <div className="overflow-hidden rounded-lg border border-border">
        {data === null ? (
          <p className="px-4 py-6 text-[13px] text-muted-foreground">
            {emptyText}
          </p>
        ) : (
          <dl className="px-3 py-2 font-mono text-[12px] leading-5">
            {Object.entries(data).map(([k, v]) => (
              <div
                key={k}
                className={
                  "flex gap-2 rounded-sm px-1 " +
                  (changed.includes(k) ? TONE[tone].line : "")
                }
              >
                <dt className="shrink-0 text-muted-foreground">{k}:</dt>
                <dd className="min-w-0 break-all whitespace-pre-wrap">
                  <FieldValue value={v} labels={labels} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </section>
  )
}

/** JSON-ish value rendering: strings quoted, null/numbers/bools plain,
 * objects pretty-printed — matching what the snapshot actually stores. */
function fmtValue(v: unknown): string {
  if (v === undefined) return "null"
  if (v !== null && typeof v === "object") return JSON.stringify(v, null, 2)
  return JSON.stringify(v)
}

/** Renders a snapshot/diff value. When the value is a UUID the backend
 * resolved to a related object (site, device, interface…), show the human
 * name and keep the raw UUID beside it, muted — so the log reads in names
 * without losing the exact reference. Everything else renders as raw JSON. */
function FieldValue({
  value,
  labels,
}: {
  value: unknown
  labels?: Record<string, string>
}) {
  if (typeof value === "string" && labels && labels[value]) {
    return (
      <span>
        <span className="font-sans font-medium">{labels[value]}</span>{" "}
        <span className="text-muted-foreground/70">{value}</span>
      </span>
    )
  }
  return <>{fmtValue(value)}</>
}

import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery, keepPreviousData } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { ChevronRight, History } from "lucide-react"

import { api } from "@/lib/api"
import type { ChangeAction, ChangeLogEntry, Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DataTable, SortHeader } from "@/components/data-table"
import { TimeCell } from "@/components/cells/time-ago"
import { QueryError } from "@/components/query-error"
import { objectDetailRoute } from "@/lib/object-routes"

export const Route = createFileRoute("/audit-log")({ component: AuditLogPage })

const ACTION_VARIANT: Record<
  ChangeAction,
  "success" | "warning" | "destructive"
> = { create: "success", update: "warning", delete: "destructive" }

const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "api.prefix", label: "Prefix" },
  { value: "api.ipaddress", label: "IP address" },
  { value: "api.device", label: "Device" },
  { value: "api.vlan", label: "VLAN" },
  { value: "api.vrf", label: "VRF" },
  { value: "api.site", label: "Site" },
  { value: "api.cable", label: "Cable" },
  { value: "api.interface", label: "Interface" },
  { value: "api.ipstatus", label: "IP status" },
  { value: "api.iprole", label: "IP role" },
]

function AuditLogPage() {
  const [action, setAction] = useState<ChangeAction | "all">("all")
  const [type, setType] = useState("all")
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)

  const params = new URLSearchParams({ page: String(page) })
  if (action !== "all") params.set("action", action)
  if (type !== "all") params.set("object_type", type)
  if (search.trim()) params.set("search", search.trim())

  const q = useQuery({
    queryKey: ["changelog", action, type, search, page],
    queryFn: () => api<Paginated<ChangeLogEntry>>(`/api/changelog/?${params}`),
    placeholderData: keepPreviousData,
  })
  const rows = q.data?.results ?? []
  const total = q.data?.count ?? 0
  const pageSize = 50
  const pages = Math.max(1, Math.ceil(total / pageSize))

  const reset = () => setPage(1)

  const columns = useMemo<ColumnDef<ChangeLogEntry>[]>(() => buildColumns(), [])

  return (
    <div className="flex h-full flex-1 flex-col">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <History className="h-4 w-4 text-muted-foreground" />
          Audit log
        </h1>
        <Badge variant="secondary" className="ml-1">
          {total.toLocaleString()}
        </Badge>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
        <div className="mx-auto max-w-6xl space-y-3">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              {(["all", "create", "update", "delete"] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => {
                    setAction(a)
                    reset()
                  }}
                  className={`inline-flex h-8 items-center rounded-md px-2.5 text-[13px] font-medium capitalize transition-colors ${
                    action === a
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {a === "all" ? "All" : a + "d"}
                </button>
              ))}
            </div>
            <Select
              value={type}
              onValueChange={(v) => {
                setType(v)
                reset()
              }}
            >
              <SelectTrigger className="h-8 w-40 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                reset()
              }}
              placeholder="Search object…"
              className="h-8 w-52 text-sm"
            />
          </div>

          {q.isError && <QueryError error={q.error} />}

          {q.data && (
            <DataTable
              data={rows}
              columns={columns}
              flexColumn="object"
              tableId="audit-log"
              exportName="audit-log"
              exportTitle="Audit log"
            />
          )}

          {pages > 1 && (
            <div className="flex items-center justify-end gap-2 text-[13px]">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="rounded-md border border-border px-2.5 py-1 disabled:opacity-40"
              >
                Prev
              </button>
              <span className="text-muted-foreground">
                {page} / {pages}
              </span>
              <button
                disabled={page >= pages}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-md border border-border px-2.5 py-1 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function buildColumns(): ColumnDef<ChangeLogEntry>[] {
  return [
    {
      id: "when",
      accessorFn: (r) => r.timestamp,
      header: ({ column }) => <SortHeader column={column} label="When" />,
      // The timestamp deep-links to the entry's detail page (full pre/post
      // snapshot + diff) — same affordance as NetBox's changelog.
      cell: ({ row }) => (
        <Link
          to="/audit-log/$id"
          params={{ id: row.original.id }}
          className="hover:underline"
        >
          <TimeCell iso={row.original.timestamp} />
        </Link>
      ),
    },
    {
      id: "user",
      accessorFn: (r) => r.user_name || "",
      header: ({ column }) => <SortHeader column={column} label="User" />,
      cell: ({ row }) => row.original.user_name || "—",
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
      id: "object",
      accessorFn: (r) => r.object_repr,
      header: ({ column }) => <SortHeader column={column} label="Object" />,
      cell: ({ row }) => {
        const e = row.original
        const route =
          e.action !== "delete" ? objectDetailRoute(e.object_type) : undefined
        return (
          <span className="block truncate">
            <span className="text-[11px] text-muted-foreground">
              {e.object_label}
            </span>{" "}
            {route ? (
              <Link
                to={route}
                params={{ id: e.object_id }}
                className="font-medium hover:underline"
              >
                {e.object_repr}
              </Link>
            ) : (
              <span className="font-medium">{e.object_repr}</span>
            )}
          </span>
        )
      },
    },
    {
      id: "changes",
      enableSorting: false,
      header: "Changes",
      cell: ({ row }) => <ChangesCell e={row.original} />,
    },
  ]
}

/** Field-level diff, revealed in place from the "Changes" cell. Keeps the
 * full before/after detail the hand-rolled expandable row used to show. */
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

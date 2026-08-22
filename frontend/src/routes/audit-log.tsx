import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery, keepPreviousData } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { ChevronRight } from "lucide-react"

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
import { FilterRail } from "@/components/filter-rail"
import { ListPageShell } from "@/components/list-page-shell"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { TimeCell } from "@/components/cells/time-ago"
import { objectDetailRoute } from "@/lib/object-routes"

export const Route = createFileRoute("/audit-log")({ component: AuditLogPage })

const ACTION_VARIANT: Record<
  ChangeAction,
  "success" | "warning" | "destructive"
> = { create: "success", update: "warning", delete: "destructive" }

const ACTION_TABS = [
  { value: "all", label: "All" },
  { value: "create", label: "Created" },
  { value: "update", label: "Updated" },
  { value: "delete", label: "Deleted" },
] as const

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

const VIA_OPTIONS = [
  { value: "all", label: "All sources" },
  { value: "ui", label: "UI" },
  { value: "api", label: "API" },
  { value: "system", label: "System" },
]

const VIA_LABEL: Record<string, string> = {
  ui: "UI",
  api: "API",
  system: "System",
}

function AuditLogPage() {
  const [action, setAction] = useState<ChangeAction | "all">("all")
  const [type, setType] = useState("all")
  const [via, setVia] = useState("all")
  const [user, setUser] = useState("")
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)

  // Explicit page_size: the API's default page is 10k rows (the SPA usually
  // paginates client-side), which made this page crawl on big logs (#59).
  const pageSize = 50
  const params = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
  })
  if (action !== "all") params.set("action", action)
  if (type !== "all") params.set("object_type", type)
  if (via !== "all") params.set("via", via)
  if (user.trim()) params.set("user", user.trim())
  if (search.trim()) params.set("search", search.trim())

  const q = useQuery({
    queryKey: ["changelog", action, type, via, user, search, page],
    queryFn: () => api<Paginated<ChangeLogEntry>>(`/api/changelog/?${params}`),
    placeholderData: keepPreviousData,
  })
  const rows = q.data?.results ?? []
  const total = q.data?.count ?? 0
  const pages = Math.max(1, Math.ceil(total / pageSize))

  const reset = () => setPage(1)

  const columns = useMemo<ColumnDef<ChangeLogEntry>[]>(() => buildColumns(), [])

  return (
    // Action is a page-level split of the whole log (server-side `action=`), so
    // it rides the canonical tab strip; object type is a rail facet; the free
    // text search is the shell's own box. All three reset to page 1.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-border px-4 lg:px-6">
        <SegmentedTabs
          value={action}
          onValueChange={(v) => {
            setAction(v)
            reset()
          }}
          items={ACTION_TABS}
        />
      </div>

      <ListPageShell
        title="Change log"
        count={q.data ? total : undefined}
        rail={
          <FilterRail>
            {/* Single-select and server-side (`object_type=`), over the full
                fixed type list - so it stays a Select rather than a FacetGroup,
                whose per-option counts the changelog API doesn't report. */}
            <div>
              <h3 className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                Object type
              </h3>
              <Select
                value={type}
                onValueChange={(v) => {
                  setType(v)
                  reset()
                }}
              >
                <SelectTrigger className="h-8 w-full text-xs">
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
            </div>
            <div>
              <h3 className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                User
              </h3>
              <Input
                value={user}
                onChange={(e) => {
                  setUser(e.target.value)
                  reset()
                }}
                placeholder="Filter by user…"
                className="h-8 text-xs"
              />
            </div>
            <div>
              <h3 className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                Source
              </h3>
              <Select
                value={via}
                onValueChange={(v) => {
                  setVia(v)
                  reset()
                }}
              >
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VIA_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </FilterRail>
        }
        search={{
          value: search,
          onChange: (v) => {
            setSearch(v)
            reset()
          },
          placeholder: "Search object…",
        }}
        query={q}
      >
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="object"
          tableId="audit-log"
          exportName="audit-log"
          exportTitle="Change log"
          serverPagination={{
            page,
            pageCount: pages,
            totalRows: total,
            onPageChange: setPage,
          }}
        />
      </ListPageShell>
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
      // snapshot + diff).
      cell: ({ row }) => (
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
      accessorFn: (r) => r.user_name || "",
      header: ({ column }) => <SortHeader column={column} label="User" />,
      cell: ({ row }) => row.original.user_name || "-",
    },
    {
      id: "via",
      accessorFn: (r) => r.via,
      header: ({ column }) => <SortHeader column={column} label="Via" />,
      cell: ({ row }) =>
        row.original.via ? (
          <Badge variant="outline">{VIA_LABEL[row.original.via]}</Badge>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
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
                className="link font-medium"
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
    return <span className="text-muted-foreground">-</span>
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

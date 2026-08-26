import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery, keepPreviousData } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { ChevronRight } from "lucide-react"

import { api } from "@/lib/api"
import type { ChangeAction, ChangeLogEntry, Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Combobox } from "@/components/ui/combobox"
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
import { objectDetailRoute, objectListRoute } from "@/lib/object-routes"
import { useCurrentHref } from "@/lib/return-to"
import {
  useUrlEnum,
  useUrlInt,
  useUrlPatch,
  useUrlText,
} from "@/lib/use-url-state"

export const Route = createFileRoute("/audit-log")({
  // Declared so the filters survive navigation: params a route doesn't
  // validate are dropped when the router rebuilds the location, which is
  // what reset the filters on Back (#109).
  validateSearch: (
    s: Record<string, unknown>
  ): {
    action?: string
    type?: string
    via?: string
    user?: string
    q?: string
    page?: number
  } => {
    const out: {
      action?: string
      type?: string
      via?: string
      user?: string
      q?: string
      page?: number
    } = {}
    for (const k of ["action", "type", "via", "user", "q"] as const) {
      if (typeof s[k] === "string" && s[k]) out[k] = s[k] as string
    }
    const page = Number(s.page)
    if (Number.isFinite(page) && page > 1) out.page = Math.round(page)
    return out
  },
  component: AuditLogPage,
})

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
  { value: "api.portreservation", label: "Port reservation" },
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
  // Filters and the page live in the URL (#109): navigate into an entry, hit
  // back, and the view is exactly where it was - like every other list. A
  // filter change and the page-1 reset go through ONE patch call; two setters
  // in the same tick would drop one (see useUrlPatch).
  const patch = useUrlPatch()
  const [action] = useUrlEnum<ChangeAction | "all">("action", "all", [
    "all",
    "create",
    "update",
    "delete",
  ])
  const [type] = useUrlText("type", "all")
  const [via] = useUrlEnum("via", "all", ["all", "ui", "api", "system"])
  const [user] = useUrlText("user")
  const [search] = useUrlText("q", "", { replace: true })
  const [page, setPage] = useUrlInt("page", 1, { min: 1 })
  const drop = (v: string, dflt: string) => (v === dflt ? undefined : v)
  const setAction = (v: ChangeAction | "all") =>
    patch({ action: drop(v, "all"), page: undefined })
  const setType = (v: string) =>
    patch({ type: drop(v, "all"), page: undefined })
  const setVia = (v: string) => patch({ via: drop(v, "all"), page: undefined })
  const setUser = (v: string) => patch({ user: drop(v, ""), page: undefined })
  const setSearch = (v: string) =>
    patch({ q: drop(v, ""), page: undefined }, { replace: true })

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
  // Who has actually made changes here - the User filter's options. Not
  // the user directory: it needs no user-management permission and lists
  // only actors visible to this caller.
  const actors = useQuery({
    queryKey: ["changelog-users"],
    queryFn: () => api<{ results: string[] }>("/api/changelog/users/"),
    staleTime: 5 * 60_000,
  })

  const rows = q.data?.results ?? []
  const total = q.data?.count ?? 0
  const pages = Math.max(1, Math.ceil(total / pageSize))

  // The list's own href travels with each row link, so the entry page can
  // come back to this exact filtered view.
  const href = useCurrentHref()
  const columns = useMemo<ColumnDef<ChangeLogEntry>[]>(
    () => buildColumns(href),
    [href]
  )

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
              <Combobox
                value={user || null}
                onChange={(v) => setUser(v ?? "")}
                options={(actors.data?.results ?? []).map((u) => ({
                  value: u,
                  label: u,
                }))}
                noneLabel="All users"
                placeholder="All users"
                searchPlaceholder="Search users…"
                emptyText="No users yet."
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
          onChange: setSearch,
          placeholder: "Search object…",
        }}
        query={q}
      >
        <DataTable
          data={rows}
          columns={columns}
          // The table holds one 50-row page; an audit export must not be
          // silently truncated to it.
          exportAll={async () => {
            const all = new URLSearchParams(params)
            all.set("page", "1")
            all.set("page_size", "10000")
            const r = await api<Paginated<ChangeLogEntry>>(
              `/api/changelog/?${all}`
            )
            return r.results
          }}
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

function buildColumns(href: string): ColumnDef<ChangeLogEntry>[] {
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
          search={{ from: href }}
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
        const alive = e.action !== "delete" && e.object_exists
        const route = alive ? objectDetailRoute(e.object_type) : undefined
        // Types without a detail page (e.g. port reservations) link to the
        // list page that shows them instead of rendering plain text.
        const listRoute =
          alive && !route ? objectListRoute(e.object_type) : undefined
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
            ) : listRoute ? (
              <Link to={listRoute} className="link font-medium">
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
        // Values can be whole JSON blobs; wrap them and cap the columns so a
        // long one can't push the diff past the container (#83). Anything
        // still too wide scrolls inside its own box, never the page.
        <div className="max-w-full overflow-x-auto">
          <table className="w-full text-[12px]">
            <tbody>
              {fields.map(([f, c]) => (
                <tr key={f}>
                  <td className="py-0.5 pr-4 align-top font-mono break-all text-muted-foreground">
                    {f}
                  </td>
                  <td className="max-w-[22rem] py-0.5 pr-2 align-top font-mono break-all whitespace-pre-wrap text-red-600 line-through dark:text-red-400">
                    <FieldVal value={c.old} label={c.old_label} />
                  </td>
                  <td className="py-0.5 pr-2 align-top text-muted-foreground">
                    →
                  </td>
                  <td className="max-w-[22rem] py-0.5 align-top font-mono break-all whitespace-pre-wrap text-emerald-600 dark:text-emerald-400">
                    <FieldVal value={c.new} label={c.new_label} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

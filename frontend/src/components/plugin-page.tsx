import { useMemo } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"

import { api, type Paginated, type Tag } from "@/lib/api"
import { type PluginColumn, type PluginPage } from "@/lib/plugins"
import { useUrlTab } from "@/lib/use-url-tab"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import { KvCard, type KvRow } from "@/components/kv-card"
import { TagList } from "@/components/cells/tag-list"
import { TimeCell } from "@/components/cells/time-ago"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"

type Row = Record<string, unknown>

// Render one field/cell value per its declared kind. Kept intentionally small —
// the server describes, this renders, no plugin code.
function renderValue(kind: string, value: unknown) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground">—</span>
  }
  switch (kind) {
    case "time":
      return <TimeCell iso={String(value)} />
    case "tags":
      return <TagList tags={(value as Tag[]) ?? []} inline />
    case "mono":
      return <span className="font-mono">{String(value)}</span>
    default:
      return <span>{String(value)}</span>
  }
}

function buildColumns(
  spec: PluginPage,
  cols: PluginColumn[]
): ColumnDef<Row, unknown>[] {
  return cols.map((c, i) => ({
    id: c.key,
    accessorKey: c.key,
    header: c.label,
    // Never truncate cells (project rule); let the table scroll instead.
    cell: ({ row }) => {
      const v = row.original[c.key]
      // First column links to the detail page when the list defines one.
      if (i === 0 && spec.detail_route) {
        const href = spec.detail_route.replace("$id", String(row.original.id))
        return (
          <Link to={href as never} className="font-mono hover:underline">
            {String(v ?? "—")}
          </Link>
        )
      }
      return renderValue(c.kind, v)
    },
  }))
}

function PluginListPage({ page }: { page: PluginPage }) {
  const query = useQuery({
    queryKey: ["plugin-list", page.endpoint],
    queryFn: () => api<Paginated<Row>>(`${page.endpoint}?page_size=100`),
  })
  const columns = useMemo(() => buildColumns(page, page.columns), [page])
  const rows = query.data?.results ?? []

  return (
    <ListPageShell title={page.title} count={query.data?.count} query={query}>
      <DataTable
        columns={columns}
        data={rows}
        tableId={`plugin:${page.plugin}:${page.path}`}
      />
    </ListPageShell>
  )
}

function PluginDetailPage({ page, id }: { page: PluginPage; id: string }) {
  const [tab, setTab] = useUrlTab("overview")
  const query = useQuery({
    queryKey: ["plugin-detail", page.endpoint, id],
    queryFn: () => api<Row>(`${page.endpoint}${id}/`),
  })
  const obj = query.data
  const title = obj ? String(obj[page.title_field] ?? id) : "…"

  const rows: KvRow[] = (page.fields ?? []).map((f) => ({
    label: f.label,
    value: obj ? renderValue(f.kind, obj[f.key]) : "…",
  }))

  const tabs = page.tabs.map((t) => ({
    value: t,
    label: t === "history" ? "History" : t[0].toUpperCase() + t.slice(1),
  }))

  const listHref = `/p/${page.plugin}/${page.path.replace(/\/\$id$/, "")}`

  return (
    <DetailShell
      backTo={listHref as never}
      backLabel={page.title}
      title={<span className="font-mono">{title}</span>}
      tabs={tabs}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <div className="grid gap-4 p-4 lg:p-6">
          <KvCard title={page.title} rows={rows} />
        </div>
      </DetailTab>
      {page.tabs.includes("history") && page.audit_type && (
        <DetailTab value="history">
          <div className="p-4 lg:p-6">
            <ChangeLogPanel objectType={page.audit_type} objectId={id} />
          </div>
        </DetailTab>
      )}
    </DetailShell>
  )
}

export function PluginPageView({
  page,
  id,
}: {
  page: PluginPage
  id?: string
}) {
  if (page.kind === "detail" && id)
    return <PluginDetailPage page={page} id={id} />
  return <PluginListPage page={page} />
}

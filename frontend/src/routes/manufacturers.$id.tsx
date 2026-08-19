import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { ExternalLink, Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import {
  api,
  type Manufacturer,
  type ModuleType,
  type Paginated,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { SimpleTable } from "@/components/ui/simple-table"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { LocalityBadge } from "@/components/locality-badge"
import { QueryError } from "@/components/query-error"
import { ManufacturerDeleteDialog } from "@/components/manufacturer-delete-dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { EmbeddedDeviceTypeTable } from "@/components/embedded-device-type-table"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/manufacturers/$id")({
  component: ManufacturerDetail,
})

function ManufacturerDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["manufacturer", id],
    queryFn: () => api<Manufacturer>(`/api/manufacturers/${id}/`),
  })
  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body manufacturer={q.data} />
}

function Body({ manufacturer: m }: { manufacturer: Manufacturer }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "device-types" | "module-types" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<Manufacturer | null>(null)
  const goBack = useCallback(() => nav({ to: "/manufacturers" }), [nav])

  return (
    <DetailShell
      backTo="/manufacturers"
      backLabel="Manufacturers"
      title={m.name}
      presence={{ type: "manufacturer", id: m.id }}
      actions={
        <>
          {canDo("manufacturer", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/manufacturers/$id/edit" params={{ id: m.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("manufacturer", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(m)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={m.name}
          description={m.description}
          statCols={1}
          stats={
            <DetailStat
              label="Device types"
              value={<span className="num">{m.device_type_count}</span>}
            />
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        {
          value: "device-types",
          label: "Device types",
          count: m.device_type_count,
        },
        {
          value: "module-types",
          label: "Module types",
          count: m.module_type_count,
        },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <ManufacturerOverview manufacturer={m} />
      </DetailTab>
      <DetailTab value="device-types">
        <EmbeddedDeviceTypeTable
          filter={{ manufacturer: m.id }}
          emptyText="No device types reference this manufacturer yet."
        />
      </DetailTab>
      <DetailTab value="module-types">
        <EmbeddedModuleTypeTable manufacturerId={m.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.manufacturer" objectId={m.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.manufacturer" objectId={m.id} />
      </DetailTab>

      <ManufacturerDeleteDialog
        manufacturer={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** Manufacturer attributes that used to crowd the header, grouped into tables.
 * Only the name, description and device-type count stay up top. */
function ManufacturerOverview({
  manufacturer: m,
}: {
  manufacturer: Manufacturer
}) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && m.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{m.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{m.slug}</span>,
      copy: m.slug,
    },
    {
      label: "Website",
      value: m.url ? (
        <a
          href={m.url}
          target="_blank"
          rel="noreferrer"
          className="link inline-flex items-center gap-1"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {m.url.replace(/^https?:\/\//, "")}
        </a>
      ) : (
        dash
      ),
      copy: m.url || undefined,
    },
  ]

  const record: KvRow[] = [
    {
      label: "Locality",
      value: <LocalityBadge owningSite={m.owning_site} />,
    },
    { label: "Created", value: <TimeCell iso={m.created_at} /> },
    { label: "Updated", value: <TimeCell iso={m.updated_at} /> },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Manufacturer" rows={details} />
      <KvCard title="Record" rows={record} />
    </div>
  )
}

function EmbeddedModuleTypeTable({
  manufacturerId,
}: {
  manufacturerId: string
}) {
  const q = useQuery({
    queryKey: ["embedded-module-types", manufacturerId],
    queryFn: () =>
      api<Paginated<ModuleType>>(
        `/api/module-types/?manufacturer=${manufacturerId}&page_size=500`
      ),
  })
  const rows = q.data?.results ?? []
  if (q.isError) return <QueryError error={q.error} />
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  return (
    <SimpleTable<ModuleType>
      data={rows}
      getRowKey={(r) => r.id}
      empty="No module types reference this manufacturer yet."
      columns={[
        {
          id: "name",
          header: "Name",
          flex: true,
          cell: (r) => (
            <Link
              to="/module-types/$id"
              params={{ id: r.id }}
              className="link font-medium"
            >
              {r.name}
            </Link>
          ),
        },
        {
          id: "part_number",
          header: "Part number",
          cell: (r) => (
            <span className="font-mono text-xs">{r.part_number || "-"}</span>
          ),
        },
        {
          id: "interfaces",
          header: "Interfaces",
          align: "right",
          cell: (r) => (
            <span className="num text-xs">{r.interface_template_count}</span>
          ),
        },
      ]}
    />
  )
}

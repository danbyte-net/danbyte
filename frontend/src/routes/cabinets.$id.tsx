import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { Cabinet } from "@/lib/api"
import { cabinetTypeLabel, outerSize, plateSize } from "@/lib/cabinets"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { TagList } from "@/components/cells/tag-list"
import { CustomFieldValues } from "@/components/custom-field-display"
import { KvCard, dash, mono } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { ObjectDocuments } from "@/components/object-documents"
import { ObjectImages } from "@/components/object-images"
import { QueryError } from "@/components/query-error"
import { StatusBadge } from "@/components/status-badge"
import { CabinetDeleteDialog } from "@/components/cabinet-delete-dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"

export const Route = createFileRoute("/cabinets/$id")({
  component: CabinetDetail,
})

const mmOrDash = (v: number | null) => (v != null ? `${v} mm` : dash)

function CabinetDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["cabinet", id],
    queryFn: () => api<Cabinet>(`/api/cabinets/${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body cabinet={q.data} />
}

function Body({ cabinet: c }: { cabinet: Cabinet }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "documents" | "journal" | "history"
  >("overview")
  const { canDo } = useMe()
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<Cabinet | null>(null)
  const openDelete = useCallback(() => setDeleting(c), [c])
  const goBack = useCallback(() => nav({ to: "/cabinets" }), [nav])
  const size = outerSize(c)

  return (
    <DetailShell
      backTo="/cabinets"
      backLabel="Cabinets"
      title={c.name}
      presence={{ type: "cabinet", id: c.id }}
      actions={
        <>
          {canDo("cabinet", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/cabinets/$id/edit" params={{ id: c.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("cabinet", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={openDelete}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <>
          <DetailHero
            title={c.name}
            badges={<StatusBadge status={c.status} />}
            subtitle={
              c.facility_id && (
                <span className="font-mono">{c.facility_id}</span>
              )
            }
            tags={c.tags.length > 0 && <TagList tags={c.tags} />}
            description={c.description}
            stats={
              <>
                <DetailStat
                  label="Site"
                  value={
                    <Link
                      to="/sites/$id"
                      params={{ id: c.site.id }}
                      className="link text-xs"
                    >
                      {c.site.name}
                    </Link>
                  }
                />
                <DetailStat
                  label="Plate"
                  value={<span className="num">{plateSize(c)}</span>}
                />
                {size && (
                  <DetailStat
                    label="Size"
                    value={<span className="num">{size}</span>}
                  />
                )}
              </>
            }
          />

          <CustomFieldValues model="cabinet" values={c.custom_fields} />
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "documents", label: "Documents", count: c.document_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <CabinetOverview cabinet={c} />
      </DetailTab>
      <DetailTab value="documents">
        <ObjectDocuments objectType="api.cabinet" objectId={c.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.cabinet" objectId={c.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.cabinet" objectId={c.id} />
      </DetailTab>

      <CabinetDeleteDialog
        cabinet={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** The cabinet's attributes and sizes, grouped into labelled tables. Only
 * name, status and site stay up top. */
function CabinetOverview({ cabinet: c }: { cabinet: Cabinet }) {
  const { humanIds } = useMe()
  const cabinetRows: KvRow[] = [
    ...(humanIds && c.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{c.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Site",
      value: (
        <Link to="/sites/$id" params={{ id: c.site.id }} className="link">
          {c.site.name}
        </Link>
      ),
    },
    {
      label: "Location",
      value: c.location ? (
        <Link
          to="/locations/$id"
          params={{ id: c.location.id }}
          className="link"
        >
          {c.location.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Role",
      value: c.role ? (
        <Link
          to="/cabinet-roles/$id"
          params={{ id: c.role.id }}
          className="link"
        >
          <ColorBadge name={c.role.name} color={c.role.color || undefined} />
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Cabinet type",
      value: c.cabinet_type ? (
        <Link
          to="/cabinet-types/$id"
          params={{ id: c.cabinet_type.id }}
          className="link"
        >
          {cabinetTypeLabel(c.cabinet_type)}
        </Link>
      ) : (
        dash
      ),
    },
    { label: "Facility ID", value: mono(c.facility_id) },
  ]
  const sizeRows: KvRow[] = [
    { label: "Plate width", value: `${c.inner_width_mm} mm` },
    { label: "Plate height", value: `${c.inner_height_mm} mm` },
    { label: "Outer width", value: mmOrDash(c.outer_width_mm) },
    { label: "Outer height", value: mmOrDash(c.outer_height_mm) },
    { label: "Outer depth", value: mmOrDash(c.outer_depth_mm) },
  ]
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <KvCard title="Cabinet" rows={cabinetRows} />
        <KvCard title="Sizes" rows={sizeRows} />
      </div>
      <ObjectImages apiBase={`/api/cabinets/${c.id}`} objectType="cabinet" />
    </div>
  )
}

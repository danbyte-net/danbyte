import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { useState } from "react"

import { api } from "@/lib/api"
import type { CabinetType } from "@/lib/api"
import { outerSize, plateSize } from "@/lib/cabinets"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { TagList } from "@/components/cells/tag-list"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { EmbeddedCabinetTable } from "@/components/embedded-tables"
import { CabinetTypeDeleteDialog } from "@/components/cabinet-type-delete-dialog"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"

export const Route = createFileRoute("/cabinet-types/$id")({
  component: CabinetTypeDetail,
})

const mmOrDash = (v: number | null) => (v != null ? `${v} mm` : dash)

function CabinetTypeDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["cabinet-type", id],
    queryFn: () => api<CabinetType>(`/api/cabinet-types/${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body cabinetType={q.data} />
}

function Body({ cabinetType: ct }: { cabinetType: CabinetType }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "cabinets" | "journal" | "history"
  >("overview")
  const { canDo, humanIds } = useMe()
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<CabinetType | null>(null)
  const size = outerSize(ct)

  const rows: KvRow[] = [
    ...(humanIds && ct.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{ct.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Manufacturer",
      value: ct.manufacturer ? (
        <Link
          to="/manufacturers/$id"
          params={{ id: ct.manufacturer.id }}
          className="link"
        >
          {ct.manufacturer.name}
        </Link>
      ) : (
        dash
      ),
    },
    { label: "Plate width", value: `${ct.inner_width_mm} mm` },
    { label: "Plate height", value: `${ct.inner_height_mm} mm` },
    { label: "Outer width", value: mmOrDash(ct.outer_width_mm) },
    { label: "Outer height", value: mmOrDash(ct.outer_height_mm) },
    { label: "Outer depth", value: mmOrDash(ct.outer_depth_mm) },
  ]

  return (
    <DetailShell
      backTo="/cabinet-types"
      backLabel="Cabinet types"
      title={ct.name}
      presence={{ type: "cabinettype", id: ct.id }}
      actions={
        <>
          {canDo("cabinettype", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/cabinet-types/$id/edit" params={{ id: ct.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("cabinettype", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(ct)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={ct.name}
          tags={ct.tags.length > 0 && <TagList tags={ct.tags} />}
          description={ct.description}
          stats={
            <>
              <DetailStat
                label="Plate"
                value={<span className="num">{plateSize(ct)}</span>}
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
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "cabinets", label: "Cabinets", count: ct.cabinet_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <div className="grid gap-6 lg:grid-cols-2">
          <KvCard title="Cabinet type" rows={rows} />
        </div>
      </DetailTab>
      <DetailTab value="cabinets">
        <CabinetsOfTypePane cabinetTypeId={ct.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.cabinettype" objectId={ct.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.cabinettype" objectId={ct.id} />
      </DetailTab>

      <CabinetTypeDeleteDialog
        cabinetType={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={() => nav({ to: "/cabinet-types" })}
      />
    </DetailShell>
  )
}

/** Cabinets of this type, and a one-click way to add another. */
function CabinetsOfTypePane({ cabinetTypeId }: { cabinetTypeId: string }) {
  const { canDo } = useMe()
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Cabinets of this type
        </h3>
        {/* Lands on the cabinet form with this type picked and its sizes
            filled. */}
        {canDo("cabinet", "add") && (
          <Button size="sm" asChild>
            <Link to="/cabinets/new" search={{ cabinet_type: cabinetTypeId }}>
              <Plus className="h-3.5 w-3.5" /> Add cabinet
            </Link>
          </Button>
        )}
      </div>
      <EmbeddedCabinetTable
        filter={{ cabinet_type: cabinetTypeId }}
        omit={["type"]}
        emptyText="No cabinets use this type yet."
      />
    </section>
  )
}

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { CabinetRole } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { ColorValueCell } from "@/components/cells/color-value-cell"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { CabinetRoleDeleteDialog } from "@/components/cabinet-role-delete-dialog"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { EmbeddedCabinetTable } from "@/components/embedded-tables"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"

export const Route = createFileRoute("/cabinet-roles/$id")({
  component: CabinetRoleDetail,
})

function CabinetRoleDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["cabinet-role", id],
    queryFn: () => api<CabinetRole>(`/api/cabinet-roles/${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body role={q.data} />
}

function Body({ role: r }: { role: CabinetRole }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "cabinets" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<CabinetRole | null>(null)
  const goBack = useCallback(() => nav({ to: "/cabinet-roles" }), [nav])

  return (
    <DetailShell
      backTo="/cabinet-roles"
      backLabel="Cabinet roles"
      title={r.name}
      presence={{ type: "cabinetrole", id: r.id }}
      actions={
        <>
          {canDo("cabinetrole", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/cabinet-roles/$id/edit" params={{ id: r.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("cabinetrole", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(r)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={<ColorBadge name={r.name} color={r.color || undefined} />}
          description={r.description}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "cabinets", label: "Cabinets", count: r.cabinet_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <CabinetRoleOverview role={r} />
      </DetailTab>
      <DetailTab value="cabinets">
        <EmbeddedCabinetTable
          filter={{ role: r.id }}
          omit={["role"]}
          emptyText="No cabinets have this role yet."
        />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.cabinetrole" objectId={r.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.cabinetrole" objectId={r.id} />
      </DetailTab>

      <CabinetRoleDeleteDialog
        role={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** The role's attributes. Only the coloured name badge and description
 * stay up top. */
function CabinetRoleOverview({ role: r }: { role: CabinetRole }) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && r.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{r.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{r.slug}</span>,
      copy: r.slug,
    },
    { label: "Color", value: <ColorValueCell color={r.color} /> },
    { label: "Created", value: <TimeCell iso={r.created_at} /> },
    { label: "Updated", value: <TimeCell iso={r.updated_at} /> },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Cabinet role" rows={details} />
    </div>
  )
}

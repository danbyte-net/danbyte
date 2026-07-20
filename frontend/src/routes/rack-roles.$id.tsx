import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type RackRole } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { QueryError } from "@/components/query-error"
import { RackRoleDeleteDialog } from "@/components/rack-role-delete-dialog"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import { EmbeddedRackTable } from "@/components/embedded-tables"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/rack-roles/$id")({
  component: RackRoleDetail,
})

function RackRoleDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["rack-role", id],
    queryFn: () => api<RackRole>(`/api/rack-roles/${id}/`),
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
  return <Body role={q.data} />
}

function Body({ role: r }: { role: RackRole }) {
  const [tab, setTab] = useUrlTab<"racks" | "journal" | "history">("racks")
  const nav = useNavigate()
  const { canDo, humanIds } = useMe()
  const [deleting, setDeleting] = useState<RackRole | null>(null)
  const goBack = useCallback(() => nav({ to: "/rack-roles" }), [nav])

  return (
    <DetailShell
      backTo="/rack-roles"
      backLabel="Rack roles"
      title={r.name}
      presence={{ type: "rackrole", id: r.id }}
      actions={
        <>
          {canDo("rackrole", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/rack-roles/$id/edit" params={{ id: r.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("rackrole", "delete") && (
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
        <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <ColorBadge name={r.name} color={r.color || undefined} />
            {r.description && (
              <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                {r.description}
              </p>
            )}
          </div>
          <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
            {humanIds && r.numid != null && (
              <DetailStat
                label="Number"
                value={<span className="num font-mono">#{r.numid}</span>}
              />
            )}
            <DetailStat
              label="Racks"
              value={<span className="num">{r.rack_count}</span>}
            />
          </dl>
        </section>
      }
      tabs={[
        { value: "racks", label: "Racks", count: r.rack_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="racks">
        <EmbeddedRackTable filter={{ role: r.id }} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.rackrole" objectId={r.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.rackrole" objectId={r.id} />
      </DetailTab>

      <RackRoleDeleteDialog
        role={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

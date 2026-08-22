import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type RackRole } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { RackRoleDeleteDialog } from "@/components/rack-role-delete-dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
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
  const [tab, setTab] = useUrlTab<"overview" | "racks" | "journal" | "history">(
    "overview"
  )
  const nav = useNavigate()
  const { canDo } = useMe()
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
        <DetailHero
          title={<ColorBadge name={r.name} color={r.color || undefined} />}
          description={r.description}
          stats={
            <DetailStat
              label="Racks"
              value={<span className="num">{r.rack_count}</span>}
            />
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "racks", label: "Racks", count: r.rack_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <RackRoleOverview role={r} />
      </DetailTab>
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

/** Rack-role attributes, moved out of the page header. Only the colored name
 * badge, description and rack count stay up top. */
function RackRoleOverview({ role: r }: { role: RackRole }) {
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
    {
      label: "Color",
      value: r.color ? (
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded-sm border border-border"
            style={{ backgroundColor: r.color }}
          />
          <span className="font-mono">{r.color}</span>
        </span>
      ) : (
        dash
      ),
    },
    { label: "Created", value: <TimeCell iso={r.created_at} /> },
    { label: "Updated", value: <TimeCell iso={r.updated_at} /> },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Rack role" rows={details} />
    </div>
  )
}

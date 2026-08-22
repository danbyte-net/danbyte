import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { CircuitType } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { CircuitTypeDeleteDialog } from "@/components/circuit-type-delete-dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { EmbeddedCircuitTable } from "@/components/embedded-tables"

export const Route = createFileRoute("/circuit-types/$id")({
  component: CircuitTypeDetail,
})

function CircuitTypeDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["circuit-type", id],
    queryFn: () => api<CircuitType>(`/api/circuit-types/${id}/`),
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
  return <Body type={q.data} />
}

function Body({ type: t }: { type: CircuitType }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "circuits" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<CircuitType | null>(null)
  const goBack = useCallback(() => nav({ to: "/circuit-types" }), [nav])

  return (
    <DetailShell
      backTo="/circuit-types"
      backLabel="Circuit types"
      title={t.name}
      presence={{ type: "circuittype", id: t.id }}
      actions={
        <>
          {canDo("circuittype", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/circuit-types/$id/edit" params={{ id: t.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("circuittype", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(t)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={<ColorBadge name={t.name} color={t.color || undefined} />}
          description={t.description}
          statCols={1}
          stats={
            <DetailStat
              label="Circuits"
              value={<span className="num">{t.circuit_count}</span>}
            />
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "circuits", label: "Circuits", count: t.circuit_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <CircuitTypeOverview type={t} />
      </DetailTab>
      <DetailTab value="circuits">
        <EmbeddedCircuitTable
          filter={{ type: t.id }}
          emptyText="No circuits use this type yet."
        />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.circuittype" objectId={t.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.circuittype" objectId={t.id} />
      </DetailTab>

      <CircuitTypeDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** Circuit-type attributes. The colored name badge, description and circuit
 * count stay in the hero; everything else lands here. */
function CircuitTypeOverview({ type: t }: { type: CircuitType }) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && t.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{t.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Name", value: t.name, copy: t.name },
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{t.slug}</span>,
      copy: t.slug,
    },
    {
      label: "Color",
      value: t.color ? (
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded-sm border border-border"
            style={{ backgroundColor: t.color }}
          />
          <span className="font-mono">{t.color}</span>
        </span>
      ) : (
        dash
      ),
    },
    { label: "Description", value: t.description || dash },
    {
      label: "Circuits",
      value: <span className="num">{t.circuit_count}</span>,
    },
  ]

  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={t.created_at} /> },
    { label: "Updated", value: <TimeCell iso={t.updated_at} /> },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Circuit type" rows={details} />
      <KvCard title="Record" rows={record} />
    </div>
  )
}
